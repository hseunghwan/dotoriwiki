/**
 * The chat store: one append-only JSONL file per Claude session, in CHATS_DIR, outside the wiki.
 * The first line names the session's target, which is the only cwd `--resume` works from, so the
 * store, not the client, says where a session runs. Transcripts never reach the wiki.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

declare const chatIdBrand: unique symbol;
/** A lower-cased Claude session UUID, safe as a file name. Minted only by parseChatId. */
export type ChatId = string & { readonly [chatIdBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const parseChatId = (s: string): ChatId | null => (UUID.test(s.toLowerCase()) ? (s.toLowerCase() as ChatId) : null);

/** The file format, one JSON object per line. */
export type ChatLine =
  | { type: 'meta'; session_id: string; target: string; created_at: string }
  | { type: 'turn'; at: string; question: string; answer: string; cited: string[] }
  | { type: 'error'; at: string; question: string; message: string };

export type ChatRecord = Exclude<ChatLine, { type: 'meta' }>;

export type ChatSession = {
  readonly id: ChatId;
  /** "root" or a domain folder name, as the wire spells it. */
  readonly target: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly records: readonly ChatRecord[];
};

/** Newest updated first; ties broken by id so a cursor never skips or repeats one. */
export type ChatCursor = { readonly updatedAt: string; readonly id: ChatId };

export type ChatStore = {
  get(id: ChatId): Promise<ChatSession | null>;
  list(page: { limit: number; before: ChatCursor | null }): Promise<readonly ChatSession[]>;
  /** Writes the meta line unless the file exists. */
  begin(id: ChatId, target: string, at: string): Promise<void>;
  append(id: ChatId, record: ChatRecord): Promise<void>;
  delete(id: ChatId): Promise<boolean>;
  /** Marks a session busy for one turn. null when a turn on it is already in flight. */
  claim(id: ChatId): (() => void) | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function parseLine(text: string): ChatLine | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  if (v.type === 'meta' && typeof v.session_id === 'string' && typeof v.target === 'string' && typeof v.created_at === 'string') return v as ChatLine;
  if (typeof v.at !== 'string' || typeof v.question !== 'string') return null;
  if (v.type === 'turn' && typeof v.answer === 'string' && strings(v.cited)) return v as ChatLine;
  if (v.type === 'error' && typeof v.message === 'string') return v as ChatLine;
  return null;
}

/** A crash mid-append can leave a torn last line; it is skipped, not fatal. */
function parseSession(id: ChatId, text: string): ChatSession | null {
  const lines = text.split('\n').flatMap((l) => (l.trim() === '' ? [] : [parseLine(l)])).filter((l) => l !== null);
  const meta = lines[0];
  if (meta?.type !== 'meta') return null;
  const records = lines.filter((l): l is ChatRecord => l.type !== 'meta');
  return { id, target: meta.target, createdAt: meta.created_at, updatedAt: records.at(-1)?.at ?? meta.created_at, records };
}

const newerFirst = (a: ChatCursor, b: ChatCursor) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export async function openChatStore(dir: string): Promise<ChatStore> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (id: ChatId) => join(dir, `${id}.jsonl`);
  const busy = new Set<ChatId>();
  const line = (l: ChatLine) => `${JSON.stringify(l)}\n`;

  async function get(id: ChatId): Promise<ChatSession | null> {
    const text = await fs.readFile(file(id), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    return text === null ? null : parseSession(id, text);
  }

  return {
    get,
    async list({ limit, before }) {
      const ids = (await fs.readdir(dir)).flatMap((n) => {
        const id = n.endsWith('.jsonl') ? parseChatId(n.slice(0, -6)) : null;
        return id ? [id] : [];
      });
      const sessions = (await Promise.all(ids.map(get))).filter((s) => s !== null);
      return sessions.sort(newerFirst).filter((s) => !before || newerFirst(s, before) > 0).slice(0, limit);
    },
    async begin(id, target, at) {
      await fs.writeFile(file(id), line({ type: 'meta', session_id: id, target, created_at: at }), { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    },
    async append(id, record) {
      await fs.appendFile(file(id), line(record));
    },
    async delete(id) {
      try {
        await fs.unlink(file(id));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
      }
    },
    claim(id) {
      if (busy.has(id)) return null;
      busy.add(id);
      return () => busy.delete(id);
    },
  };
}

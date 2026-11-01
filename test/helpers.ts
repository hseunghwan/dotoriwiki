import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { openChatStore } from '../src/chats.ts';
import { copyPreset } from '../src/init.ts';
import { startHttp, type HttpDeps } from '../src/http.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  openWiki, parseMemo, type ClassifyRequest, type Classification, type EditRequest, type EditResult, type FetchedSource, type FetchSource,
  type Llm, type NewMemo, type ShrinkPhoto, type Unavailable, type Wiki, type WikiOptions,
} from '../src/wiki/index.ts';

/** A fresh git work tree holding a copy of a preset (presets/<locale>), with no commits. */
export async function tempWiki(locale: 'ko' | 'en' = 'ko'): Promise<string> {
  const root = await fs.mkdtemp(join(process.env.DOTORIWIKI_TEST_TMP ?? tmpdir(), 'dotoriwiki-test-'));
  await copyPreset(locale, root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

export type FakeLlm = Llm & {
  classifyCalls: ClassifyRequest[];
  editCalls: EditRequest[];
  classifyWith: (req: ClassifyRequest) => Promise<Classification | Unavailable>;
  editWith: (req: EditRequest) => Promise<EditResult | Unavailable>;
};

export function fakeLlm(): FakeLlm {
  const llm: FakeLlm = {
    classifyCalls: [],
    editCalls: [],
    classifyWith: async () => ({ kind: 'classified', domain: '스터디', confidence: 0.9, reason: 'fake' }),
    editWith: writesValidPage(),
    classify: (req) => {
      llm.classifyCalls.push(req);
      return llm.classifyWith(req);
    },
    edit: (req) => {
      llm.editCalls.push(req);
      return llm.editWith(req);
    },
  };
  return llm;
}

export const rawIdOf = (req: EditRequest) => /raw\/([^/.`]+)\.md/.exec(req.prompt)![1]!;

/** Writes a file the way the model would: relative to the run's cwd, reported through onTouch. */
export async function modelWrites(req: EditRequest, relPath: string, content: string): Promise<void> {
  const abs = join(req.cwd, relPath);
  req.onTouch(abs);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

export function page(fields: Record<string, unknown>, body = '본문.\n'): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${fm.join('\n')}\n---\n${body}`;
}

export const validFields = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'concept', summary: `요약 ${id}`, aliases: [], status: 'active', sources: [id], updated: '2026-10-29', ...extra,
});

/** Default edit: one valid concept page named after the memo id. */
export function writesValidPage(name?: (id: string) => string) {
  return async (req: EditRequest): Promise<EditResult> => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/${name ? name(id) : `메모 ${id}`}.md`, page(validFields(id)));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
}

export type FakeFetch = FetchSource & { calls: string[]; respond: (url: string) => Promise<FetchedSource> };

export function fakeFetch(): FakeFetch {
  const f = Object.assign((url: string) => {
    f.calls.push(url);
    return f.respond(url);
  }, {
    calls: [] as string[],
    respond: async (url: string): Promise<FetchedSource> => ({ kind: 'article', status: 'ok', title: `제목 ${url}`, text: `본문 ${url}` }),
  });
  return f;
}

/** Stands in for sips: the copy is the original's bytes, so tests read the same EXIF from both. */
export const copyShrink: ShrinkPhoto = async (src, dst) => {
  await fs.copyFile(src, dst);
};

const noFetch: FetchSource = async (url) => {
  throw new Error(`unexpected fetch of ${url}`);
};

export const options = (llm: Llm, extra: Partial<WikiOptions> = {}): WikiOptions => ({
  llm,
  fetchSource: noFetch,
  shrinkPhoto: copyShrink,
  maxAttempts: 3,
  reviewBelowConfidence: 0.6,
  ingestTimeoutMs: 5_000,
  committer: { name: 'dotoriwiki-test', email: 'test@localhost' },
  modelProfiles: ['default'],
  now: () => new Date('2026-10-29T00:00:00Z'),
  ...extra,
});

export async function open(root: string, llm: Llm, extra: Partial<WikiOptions> = {}): Promise<Wiki> {
  return openWiki(root, options(llm, extra));
}

/** Rewrites dotoriwiki.yaml through a plain-object edit, as a user would by hand. */
export async function editConfig(root: string, change: (c: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const file = join(root, 'dotoriwiki.yaml');
  await fs.writeFile(file, stringifyYaml(change(parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>)));
}

export const ulid = (n: number) => `01JB8ZQ4M3T9X7K2W5R6N8P${String(n).padStart(3, '0')}`;

export function memo(n: number, text = `메모 ${n}`, extra: Record<string, unknown> = {}): NewMemo {
  const r = parseMemo({ id: ulid(n), text, captured_at: `2026-10-29T08:${String(n % 60).padStart(2, '0')}:00+09:00`, tz: 'Asia/Seoul', source: 'typed', ...extra });
  if (!r.ok) throw new Error(r.detail);
  return r.value;
}

export const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
export const headFile = (root: string, path: string) => {
  try {
    return git(root, 'show', `HEAD:${path}`);
  } catch {
    return null;
  }
};
export const commitSubjects = (root: string) => git(root, 'log', '--format=%s').trim().split('\n').reverse();
export const ledgerLines = (root: string, d: string) => (headFile(root, `${d}/wiki/log.md`) ?? '').split('\n').filter((l) => l.startsWith('## ['));
export const readText = (path: string) => fs.readFile(path, 'utf8').catch(() => null);
export const listDir = (path: string) => fs.readdir(path).then((n) => n.filter((x) => !x.startsWith('.')).sort(), () => [] as string[]);

export const TOKEN = 'test-token-0123456789';

const unclosed = new Set<() => Promise<void>>();
// A test that fails before its own close() would leave the server up and the file would never exit.
after(async () => {
  for (const close of unclosed) await close();
});

/** `close`, also run after the file's last test if the test that opened it did not. */
export function closeAtEnd(close: () => Promise<void>): () => Promise<void> {
  const once = async () => {
    if (unclosed.delete(once)) await close();
  };
  unclosed.add(once);
  return once;
}

/** A gateway on a fresh preset wiki and an empty chat store, with a `call` that parses JSON replies. */
export async function serveHttp(opts: { chat?: HttpDeps['chat']; now?: () => Date } = {}) {
  const root = await tempWiki();
  const chatsDir = await fs.mkdtemp(join(process.env.DOTORIWIKI_TEST_TMP ?? tmpdir(), 'dotoriwiki-chats-'));
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const http = await startHttp(
    {
      wiki, chat: opts.chat ?? async function* () {}, chats: await openChatStore(chatsDir), token: TOKEN, serverVersion: '0.1.0',
      now: opts.now ?? (() => new Date('2026-10-29T00:00:00Z')), maxBodyBytes: 4096,
    },
    { host: '127.0.0.1', port: 0 },
  );
  const base = `http://127.0.0.1:${http.port}`;
  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  };
  return { root, chatsDir, base, wiki, llm, call, close: closeAtEnd(async () => (await http.close(), await wiki.close())) };
}

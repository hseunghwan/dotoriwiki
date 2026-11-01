import { File, UploadType } from 'expo-file-system';
import { copy } from '../text';
import { classify, type Attempt, type HttpOutcome, type OutboxFile } from './outbox';
import type { Candidate, Pairing, PairingFailure } from './pairing';
import { createSseParser } from './sse';
import type {
  AnswerRequest, ChatDetailWire, ChatFrame, ChatListResponse, ChatRequest, HeldResponse, MemoDetailWire, MemoListResponse, ReleaseResponse, RetryRequest, StatusResponse,
} from './wire';

export type Failure =
  | { kind: 'unreachable'; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'http'; status: number; error: string | null; detail: string | null }
  | { kind: 'malformed' };

export type Result<T> = { ok: true; data: T } | { ok: false; failure: Failure };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Raw = { status: number; json: unknown } | { network: string };

let onUnauthorized: () => void = () => {};
let onReachability: (reachable: boolean) => void = () => {};

/** App state learns about a 401 or a dead connection from any call, not only from the call site that saw it. */
export function observeGateway(handlers: { unauthorized: () => void; reachability: (reachable: boolean) => void }): void {
  onUnauthorized = handlers.unauthorized;
  onReachability = handlers.reachability;
}

async function raw(base: { url: string; token: string }, method: 'GET' | 'POST' | 'DELETE', path: string, body: string | null, timeoutMs: number): Promise<Raw> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${base.token}`, ...(body !== null ? { 'content-type': 'application/json' } : {}) },
      body,
      signal: abort.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { network: abort.signal.aborted ? copy.network.timeout(Math.round(timeoutMs / 1000)) : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function report(r: Raw): void {
  onReachability(!('network' in r));
  if (!('network' in r) && r.status === 401) onUnauthorized();
}

function toResult<T>(r: Raw, parse: (json: unknown) => T | null): Result<T> {
  report(r);
  if ('network' in r) return { ok: false, failure: { kind: 'unreachable', message: r.network } };
  if (r.status === 401) return { ok: false, failure: { kind: 'unauthorized' } };
  if (r.status < 200 || r.status >= 300) {
    const e = isRecord(r.json) ? r.json : {};
    return { ok: false, failure: { kind: 'http', status: r.status, error: typeof e.error === 'string' ? e.error : null, detail: typeof e.detail === 'string' ? e.detail : null } };
  }
  const data = parse(r.json);
  return data === null ? { ok: false, failure: { kind: 'malformed' } } : { ok: true, data };
}

function parseStatus(v: unknown): StatusResponse | null {
  if (!isRecord(v) || typeof v.server !== 'string' || !isRecord(v.domains)) return null;
  for (const d of Object.values(v.domains)) if (!isRecord(d) || typeof d.pending !== 'number' || typeof d.held !== 'number') return null;
  return v as StatusResponse;
}
const parseList = (v: unknown) => (isRecord(v) && Array.isArray(v.memos) ? (v as MemoListResponse) : null);
const parseDetail = (v: unknown) => (isRecord(v) && typeof v.id === 'string' && Array.isArray(v.pages) ? (v as MemoDetailWire) : null);
const parseHeld = (v: unknown) => (isRecord(v) && Array.isArray(v.held) ? (v as HeldResponse) : null);
const parseRelease = (v: unknown) => (isRecord(v) && v.status === 'released' ? (v as ReleaseResponse) : null);
const anyRecord = (v: unknown) => (isRecord(v) ? v : null);
const parseChats = (v: unknown) => (isRecord(v) && Array.isArray(v.chats) ? (v as ChatListResponse) : null);
const parseChat = (v: unknown) => (isRecord(v) && typeof v.session_id === 'string' && Array.isArray(v.turns) ? (v as ChatDetailWire) : null);

const TIMEOUT = 10_000;
const enc = encodeURIComponent;

export const gateway = {
  status: async (p: Pairing) => toResult(await raw(p, 'GET', '/status', null, 8_000), parseStatus),
  memos: async (p: Pairing, before: string | null, limit = 30) =>
    toResult(await raw(p, 'GET', `/memos?limit=${limit}${before ? `&before=${enc(before)}` : ''}`, null, TIMEOUT), parseList),
  memo: async (p: Pairing, id: string) => toResult(await raw(p, 'GET', `/memos/${enc(id)}`, null, TIMEOUT), parseDetail),
  held: async (p: Pairing) => toResult(await raw(p, 'GET', '/held', null, TIMEOUT), parseHeld),
  confirm: async (p: Pairing, id: string) => toResult(await raw(p, 'POST', `/memos/${enc(id)}/confirm`, null, TIMEOUT), parseRelease),
  /** A move from a gave-up memo waits for that domain's lane, which can take as long as one ingest. */
  move: async (p: Pairing, id: string, domain: string) =>
    toResult(await raw(p, 'POST', `/memos/${enc(id)}/move`, JSON.stringify({ domain }), 15 * 60_000), parseRelease),
  retry: async (p: Pairing, req: RetryRequest) => toResult(await raw(p, 'POST', '/jobs/retry', JSON.stringify(req), TIMEOUT), anyRecord),
  answer: async (p: Pairing, req: AnswerRequest) => toResult(await raw(p, 'POST', '/answers', JSON.stringify(req), TIMEOUT), anyRecord),
  chats: async (p: Pairing, before: string | null, limit = 30) =>
    toResult(await raw(p, 'GET', `/chats?limit=${limit}${before ? `&before=${enc(before)}` : ''}`, null, TIMEOUT), parseChats),
  chatDetail: async (p: Pairing, id: string) => toResult(await raw(p, 'GET', `/chats/${enc(id)}`, null, TIMEOUT), parseChat),
  deleteChat: async (p: Pairing, id: string) => toResult(await raw(p, 'DELETE', `/chats/${enc(id)}`, null, TIMEOUT), () => true),

  async postMemo(p: Pairing, body: string): Promise<Attempt> {
    const r = await raw(p, 'POST', '/memos', body, 15_000);
    report(r);
    const outcome: HttpOutcome = 'network' in r ? r : { status: r.status, detail: isRecord(r.json) && typeof r.json.detail === 'string' ? r.json.detail : null };
    return classify(outcome);
  },

  /**
   * PUT /attachments/:id/:n. expo-file-system streams the file from disk through OkHttp, so a 10 MB
   * photo never passes through JS as base64. Its timeouts are 60 s per read or write, not per upload.
   */
  async putAttachment(p: Pairing, file: OutboxFile): Promise<Attempt> {
    let r: Raw;
    try {
      const res = await new File(file.path).upload(`${p.url}/attachments/${enc(file.memo_id)}/${file.n}`, {
        httpMethod: 'PUT',
        uploadType: UploadType.BINARY_CONTENT,
        headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/octet-stream' },
      });
      let json: unknown = null;
      try {
        json = res.body ? JSON.parse(res.body) : null;
      } catch {}
      r = { status: res.status, json };
    } catch (e) {
      r = { network: (e as Error).message };
    }
    report(r);
    return classify('network' in r ? r : { status: r.status, detail: isRecord(r.json) && typeof r.json.detail === 'string' ? r.json.detail : null });
  },

  /** GET /attachments/:file, the 2048 px JPEG, as an Image source. */
  attachmentSource: (p: Pairing, file: string) => ({ uri: `${p.url}/attachments/${enc(file)}`, headers: { authorization: `Bearer ${p.token}` } }),

  /** Pairing check: GET /status with the offered url and token, sorted into the failures the first-run screen tells apart. */
  async check(c: Candidate): Promise<{ ok: true; pairing: Pairing; status: StatusResponse } | { ok: false; failure: PairingFailure }> {
    const r = await raw(c, 'GET', '/status', null, 8_000);
    if ('network' in r) return { ok: false, failure: 'unreachable' };
    if (r.status === 401) return { ok: false, failure: 'unauthorized' };
    const status = r.status === 200 ? parseStatus(r.json) : null;
    if (!status) return { ok: false, failure: 'unexpected' };
    return { ok: true, pairing: { url: c.url, token: c.token, server: status.server }, status };
  },

  async chat(p: Pairing, req: ChatRequest, signal: AbortSignal, onFrame: (f: ChatFrame) => void): Promise<Result<null>> {
    let res: Response;
    try {
      res = await fetch(`${p.url}/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal,
      });
    } catch (e) {
      onReachability(false);
      return { ok: false, failure: { kind: 'unreachable', message: (e as Error).message } };
    }
    onReachability(true);
    if (res.status !== 200 || !res.body) {
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {}
      return toResult({ status: res.status, json }, () => null);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of parser.push(decoder.decode(value, { stream: true }))) onFrame(f);
      }
    } catch (e) {
      if (signal.aborted) return { ok: true, data: null };
      return { ok: false, failure: { kind: 'unreachable', message: (e as Error).message } };
    }
    return { ok: true, data: null };
  },
};

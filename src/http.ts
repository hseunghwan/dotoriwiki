/**
 * HTTP shell: auth, wire → domain parsing, SSE. node:http, no framework. This is the boundary:
 * everything it hands inward is a validated domain value, and nothing it gets back is a wire
 * type until it serializes the reply. Handlers never enqueue; they write through Wiki, and the
 * watcher wakes the loops.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AnswerResponse, ChatFrame, ErrorResponse, HeldResponse, MemoListResponse, ReleaseResponse, RetryResponse, StatusResponse } from './api.ts';
import type { ChatOut, ChatTurn } from './chat.ts';
import {
  domainIn, pageRefString, parseAnswerId, parseMemoId, parsePageRef, WikiConfigError, type AnswerFiling, type JobRef, type MemoCursor, type MemoId,
  type Parsed, type PageRef, type ReleaseResult, type Wiki,
} from './wiki/index.ts';
import { handleMcp } from './mcp.ts';
import { acceptMemo, detailWire, listItem } from './wire.ts';

export type HttpDeps = {
  readonly wiki: Wiki;
  readonly chat: (turn: ChatTurn, signal: AbortSignal) => AsyncIterable<ChatOut>;
  readonly token: string;
  readonly serverVersion: string;
  readonly now: () => Date;
  readonly maxBodyBytes: number;
};

export type Listen = { readonly host: string; readonly port: number };

type Reply = { readonly status: number; readonly body: unknown };
const json = (status: number, body: unknown): Reply => ({ status, body });
const error = (status: number, code: ErrorResponse['error'], detail?: string): Reply => json(status, { error: code, ...(detail ? { detail } : {}) } satisfies ErrorResponse);
const bad = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const digest = (s: string) => createHash('sha256').update(s).digest();
function authorized(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m !== null && timingSafeEqual(digest(m[1]!), digest(token));
}

class BodyError extends Error {
  readonly status: number;
  readonly code: ErrorResponse['error'];
  constructor(status: number, code: ErrorResponse['error'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new BodyError(413, 'too_large', `body over ${max} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError(400, 'bad_request', 'body is not JSON');
  }
}


function nonEmpty(v: unknown, field: string): Parsed<string> {
  return typeof v === 'string' && v.trim() !== '' ? { ok: true, value: v } : bad(`${field}: required`);
}

export async function parseAnswerRequest(body: unknown, wiki: Wiki, now: Date): Promise<Parsed<AnswerFiling>> {
  if (!isRecord(body)) return bad('body: expected a JSON object');
  const id = typeof body.id === 'string' ? parseAnswerId(body.id) : null;
  if (!id) return bad('id: expected a ULID or UUID');
  const config = await wiki.config();
  const domain = typeof body.domain === 'string' ? domainIn(config, body.domain) : null;
  if (!domain) return bad('domain: not a domain');
  const question = nonEmpty(body.question, 'question');
  if (!question.ok) return question;
  const answer = nonEmpty(body.answer, 'answer');
  if (!answer.ok) return answer;
  if (!Array.isArray(body.cited) || !body.cited.every((c) => typeof c === 'string')) return bad('cited: expected an array of strings');
  const domains = [...config.domains.keys()];
  const cited: PageRef[] = [];
  for (const c of body.cited as string[]) {
    const ref = parsePageRef(c, domain, domains);
    if (!ref) return bad(`cited: empty page name`);
    cited.push(ref);
  }
  const sessionId = body.session_id;
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') return bad('session_id: expected a string');
  return {
    ok: true,
    value: { id, domain, question: question.value, answer: answer.value, cited, sessionId: typeof sessionId === 'string' ? sessionId : null, askedAt: now.toISOString() },
  };
}

export async function parseChatRequest(body: unknown, wiki: Wiki): Promise<Parsed<ChatTurn>> {
  if (!isRecord(body)) return bad('body: expected a JSON object');
  const target = body.target === 'root' ? ({ kind: 'root' } as const) : typeof body.target === 'string' ? domainIn(await wiki.config(), body.target) : null;
  if (!target) return bad('target: "root" or a domain');
  const message = nonEmpty(body.message, 'message');
  if (!message.ok) return message;
  const sid = body.session_id;
  if (sid !== undefined && sid !== null && (typeof sid !== 'string' || !UUID.test(sid))) return bad('session_id: expected a UUID');
  return {
    ok: true,
    value: { target: typeof target === 'string' ? { kind: 'domain', domain: target } : target, message: message.value, sessionId: typeof sid === 'string' ? sid : null },
  };
}

export function parseMemoListQuery(url: string): Parsed<{ limit: number; before: MemoCursor | null }> {
  const q = new URL(url, 'http://localhost').searchParams;
  const rawLimit = q.get('limit');
  const limit = rawLimit === null ? 30 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > 100) return bad('limit: an integer from 1 to 100');
  // A client that forgets to percent-encode sends the offset's `+` as a space; no cursor has a space.
  const before = q.get('before')?.replaceAll(' ', '+') ?? null;
  if (before === null) return { ok: true, value: { limit, before: null } };
  const bar = before.lastIndexOf('|');
  const capturedAt = bar < 0 ? before : before.slice(0, bar);
  const id = bar < 0 ? null : parseMemoId(before.slice(bar + 1));
  if (Number.isNaN(Date.parse(capturedAt)) || (bar >= 0 && !id)) return bad('before: expected a next_before value');
  return { ok: true, value: { limit, before: { capturedAt, id } } };
}

export async function parseRetryRequest(body: unknown, wiki: Wiki): Promise<Parsed<JobRef>> {
  if (!isRecord(body)) return bad('body: expected a JSON object');
  const domain = typeof body.domain === 'string' ? domainIn(await wiki.config(), body.domain) : null;
  if (!domain) return bad('domain: not a domain');
  const kind = body.kind;
  if (kind !== 'ingest' && kind !== 'file-answer') return bad('kind: ingest or file-answer');
  const id = typeof body.id === 'string' ? (kind === 'ingest' ? parseMemoId(body.id) : parseAnswerId(body.id)) : null;
  if (!id) return bad('id: expected a ULID or UUID');
  return { ok: true, value: { kind, domain, id } };
}


async function postMemo(deps: HttpDeps, body: unknown): Promise<Reply> {
  const r = await acceptMemo(deps.wiki, body);
  if (!r.ok) return error(400, 'bad_request', r.detail);
  return json(r.value.status === 'accepted' ? 201 : 200, r.value);
}

async function postAnswer(deps: HttpDeps, body: unknown): Promise<Reply> {
  const parsed = await parseAnswerRequest(body, deps.wiki, deps.now());
  if (!parsed.ok) return error(400, 'bad_request', parsed.detail);
  const r = await deps.wiki.fileAnswer(parsed.value);
  if (r.kind === 'rejected') return error(422, 'unprocessable', r.reason);
  return json(r.kind === 'created' ? 202 : 200, { id: parsed.value.id, status: r.kind === 'created' ? 'accepted' : 'duplicate' } satisfies AnswerResponse);
}

async function postRetry(deps: HttpDeps, body: unknown): Promise<Reply> {
  const parsed = await parseRetryRequest(body, deps.wiki);
  if (!parsed.ok) return error(400, 'bad_request', parsed.detail);
  const r = await deps.wiki.retry(parsed.value);
  return r.kind === 'retrying' ? json(200, { status: 'retrying' } satisfies RetryResponse) : error(409, 'conflict', 'job has not given up');
}

function memoIdParam(param: string | null): Parsed<MemoId> {
  let id: MemoId | null = null;
  try {
    id = param === null ? null : parseMemoId(decodeURIComponent(param));
  } catch {
    id = null;
  }
  return id ? { ok: true, value: id } : bad('id: expected a ULID or UUID');
}

function released(id: MemoId, r: ReleaseResult): Reply {
  switch (r.kind) {
    case 'released': return json(200, { id, status: 'released', domain: r.domain } satisfies ReleaseResponse);
    case 'not-found': return error(404, 'not_found', 'no such memo');
    case 'conflict': return error(409, 'conflict', r.state);
  }
}

async function postConfirm(deps: HttpDeps, param: string | null): Promise<Reply> {
  const id = memoIdParam(param);
  if (!id.ok) return error(400, 'bad_request', id.detail);
  return released(id.value, await deps.wiki.confirm(id.value));
}

async function postMove(deps: HttpDeps, body: unknown, param: string | null): Promise<Reply> {
  const id = memoIdParam(param);
  if (!id.ok) return error(400, 'bad_request', id.detail);
  const to = isRecord(body) && typeof body.domain === 'string' ? domainIn(await deps.wiki.config(), body.domain) : null;
  if (!to) return error(400, 'bad_request', 'domain: not a domain');
  return released(id.value, await deps.wiki.move(id.value, to));
}

async function getHeld(deps: HttpDeps): Promise<Reply> {
  const held = (await deps.wiki.held()).map((h) => ({
    id: h.id,
    domain: h.domain,
    text: Array.from(h.text).slice(0, 280).join(''),
    captured_at: h.capturedAt,
    source: h.source,
    confidence: h.routing.by === 'classifier' ? h.routing.confidence : null,
    reason: 'reason' in h.routing ? h.routing.reason : '',
  }));
  return json(200, { held } satisfies HeldResponse);
}

/** Asks for one memo past the page to learn whether a next page exists and whether its first memo ties the cursor. */
async function getMemos(deps: HttpDeps, req: IncomingMessage): Promise<Reply> {
  const q = parseMemoListQuery(req.url ?? '');
  if (!q.ok) return error(400, 'bad_request', q.detail);
  const { limit, before } = q.value;
  const rows = await deps.wiki.memos({ limit: limit + 1, before });
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.memo;
  const next = rows[limit]?.memo;
  const nextBefore = !last || !next ? null : Date.parse(next.capturedAt) === Date.parse(last.capturedAt) ? `${last.capturedAt}|${last.id}` : last.capturedAt;
  return json(200, { memos: page.map(listItem), next_before: nextBefore } satisfies MemoListResponse);
}

async function getMemo(deps: HttpDeps, param: string | null): Promise<Reply> {
  const id = memoIdParam(param);
  if (!id.ok) return error(400, 'bad_request', id.detail);
  const d = await deps.wiki.memo(id.value);
  return d ? json(200, detailWire(d)) : error(404, 'not_found', 'no such memo');
}

async function getStatus(deps: HttpDeps): Promise<Reply> {
  const s = await deps.wiki.status();
  const domains: StatusResponse['domains'] = {};
  for (const d of s.domains) {
    domains[d.domain] = {
      pending: d.pending, held: d.held, failed: d.failed, running: d.running && { kind: d.running.kind, id: d.running.id, since: d.running.since },
      agents_may_read: d.agentsMayRead, model_profile: d.modelProfile,
    };
  }
  const config = { state: s.paused ? 'paused' : 'ok', problems: s.problems.map(({ key, problem, fix }) => ({ key, problem, fix })) } as const;
  return json(200, { server: deps.serverVersion, inbox: s.inbox, domains, config } satisfies StatusResponse);
}

function frame(out: ChatOut): ChatFrame {
  switch (out.kind) {
    case 'session': return { type: 'session', session_id: out.sessionId };
    case 'text': return { type: 'delta', text: out.text };
    case 'done': return { type: 'done', session_id: out.sessionId, cited: out.cited.map(pageRefString) };
    case 'error': return { type: 'error', message: out.message };
  }
}

/** Writes one SSE frame per ChatOut; the turn is aborted (its claude process killed) if the client goes away. */
async function postChat(deps: HttpDeps, body: unknown, req: IncomingMessage, res: ServerResponse): Promise<Reply | null> {
  const parsed = await parseChatRequest(body, deps.wiki);
  if (!parsed.ok) return error(400, 'bad_request', parsed.detail);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (f: ChatFrame) => {
    const { type, ...data } = f;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    for await (const out of deps.chat(parsed.value, abort.signal)) send(frame(out));
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
  res.end();
  return null;
}

const mcpMethodNotAllowed = json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });

/** `param` is the raw `:id` path segment of a /memos/:id route. */
type Route = (deps: HttpDeps, body: unknown, req: IncomingMessage, res: ServerResponse, param: string | null) => Promise<Reply | null>;
const ROUTES: Record<string, Route> = {
  'POST /memos': (d, b) => postMemo(d, b),
  'GET /memos': (d, _b, q) => getMemos(d, q),
  'GET /memos/:id': (d, _b, _q, _s, id) => getMemo(d, id),
  'POST /memos/:id/confirm': (d, _b, _q, _s, id) => postConfirm(d, id),
  'POST /memos/:id/move': (d, b, _q, _s, id) => postMove(d, b, id),
  'GET /held': (d) => getHeld(d),
  'POST /answers': (d, b) => postAnswer(d, b),
  'POST /jobs/retry': (d, b) => postRetry(d, b),
  'POST /chat': postChat,
  'GET /status': (d) => getStatus(d),
  'POST /mcp': (d, b, q, s) => handleMcp(d, b, q, s).then(() => null),
  // Stateless MCP: no server-initiated stream to GET and no session to DELETE.
  'GET /mcp': async () => mcpMethodNotAllowed,
  'DELETE /mcp': async () => mcpMethodNotAllowed,
};

export async function startHttp(deps: HttpDeps, listen: Listen): Promise<{ readonly port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const send = (r: Reply) => {
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.body));
      };
      try {
        if (!authorized(req, deps.token)) return send(error(401, 'unauthorized'));
        const path = (req.url ?? '').split('?')[0]!;
        const memoAction = /^\/memos\/([^/]+)(\/[a-z]+)?$/.exec(path);
        const route = ROUTES[`${req.method} ${memoAction ? `/memos/:id${memoAction[2] ?? ''}` : path}`];
        if (!route) return send(error(404, 'not_found'));
        const body = req.method === 'POST' ? await readJson(req, deps.maxBodyBytes) : null;
        const reply = await route(deps, body, req, res, memoAction ? memoAction[1]! : null);
        if (reply) send(reply);
      } catch (e) {
        if (res.headersSent) return void res.end();
        if (e instanceof BodyError) return send(error(e.status, e.code, e.message));
        if (e instanceof WikiConfigError) return send(error(503, 'paused', e.message));
        console.error(JSON.stringify({ t: new Date().toISOString(), where: 'http', error: (e as Error).stack }));
        send(error(500, 'internal'));
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolveListen());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

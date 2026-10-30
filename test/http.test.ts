import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttp } from '../src/http.ts';
import type { ChatOut } from '../src/chat.ts';
import type { DomainName } from '../src/wiki/index.ts';
import { fakeLlm, listDir, open, tempWiki } from './helpers.ts';

const TOKEN = 'test-token-0123456789';

async function serve(chat: () => AsyncIterable<ChatOut> = async function* () {}) {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const http = await startHttp({ wiki, chat, token: TOKEN, serverVersion: '0.1.0', now: () => new Date('2026-10-29T00:00:00Z'), maxBodyBytes: 4096 }, { host: '127.0.0.1', port: 0 });
  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${http.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  };
  return { root, wiki, llm, call, close: async () => (await http.close(), await wiki.close()) };
}

const memoBody = {
  id: '3f1d2c4b-5a69-4e7f-8a1b-2c3d4e5f6a7b',
  text: '- 대시로 시작하는 메모',
  captured_at: '2026-10-29T08:10:00+09:00',
  tz: 'Asia/Seoul',
  location: { lat: 37.5, lon: 127.0 },
  source: 'typed',
  domain_hint: '스터디',
};

test('POST /memos is idempotent: the same id twice succeeds twice and yields one raw file', async () => {
  const s = await serve();
  assert.deepEqual(await s.call('POST', '/memos', memoBody), { status: 201, body: { id: memoBody.id, status: 'accepted' } });
  assert.deepEqual(await s.call('POST', '/memos', memoBody), { status: 200, body: { id: memoBody.id, status: 'duplicate', state: 'inbox', domain: null } });
  assert.deepEqual(await listDir(join(s.root, 'inbox')), [`${memoBody.id}.md`], 'one inbox file');

  assert.equal((await s.wiki.routeNext()).kind, 'routed');
  assert.deepEqual(await s.call('POST', '/memos', { ...memoBody, id: memoBody.id.toUpperCase(), text: 'changed text' }), {
    status: 200, body: { id: memoBody.id, status: 'duplicate', state: 'routed', domain: '스터디' },
  }, 'a resend after routing, even with the id upper-cased, is a duplicate');
  assert.deepEqual(await listDir(join(s.root, 'inbox')), [], 'the resend left no inbox copy');
  assert.deepEqual(await listDir(join(s.root, '스터디', 'raw')), [`${memoBody.id}.md`], 'one raw file');

  assert.equal((await s.wiki.runNext('스터디' as DomainName)).kind, 'committed');
  assert.equal((await s.call('POST', '/memos', memoBody)).body.state, 'ingested');
  assert.deepEqual(await listDir(join(s.root, '스터디', 'raw')), [`${memoBody.id}.md`], 'still one raw file');
  await s.close();
});

test('the boundary rejects bad tokens, bodies, and fields before anything is written', async () => {
  const s = await serve();
  assert.equal((await s.call('GET', '/status', undefined, 'wrong-token-0123456789')).status, 401);
  assert.equal((await s.call('POST', '/memos', '{not json')).status, 400);
  assert.equal((await s.call('POST', '/memos', { ...memoBody, text: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual((await s.call('POST', '/memos', { ...memoBody, captured_at: '2026-10-29T08:10:00' })).body, { error: 'bad_request', detail: 'captured_at: needs ISO-8601 with an offset' });
  assert.equal((await s.call('POST', '/memos', { ...memoBody, id: '../../etc' })).status, 400);
  assert.equal((await s.call('POST', '/memos', { ...memoBody, tz: 'Mars/Base' })).status, 400);
  assert.deepEqual((await s.call('POST', '/memos', { ...memoBody, context: 'notes-app' })).body, { error: 'bad_request', detail: 'context: expected an object' });
  assert.deepEqual((await s.call('POST', '/memos', { ...memoBody, context: { project: '', cwd: '/x', branch: null } })).body, { error: 'bad_request', detail: 'context.project: required' });
  assert.equal((await s.call('GET', '/nope')).status, 404);
  assert.equal((await s.call('POST', '/chat', { target: '스터디', message: 'q', session_id: '--dangerously-skip-permissions' })).status, 400, 'session id must be a UUID');
  assert.deepEqual(await listDir(join(s.root, 'inbox')), []);
  await s.close();
});

test('status, answers, and retry speak the wire contract', async () => {
  const s = await serve();
  const status = await s.call('GET', '/status');
  const idle = { pending: 0, held: 0, failed: 0, running: null, model_profile: null };
  assert.deepEqual(status, {
    status: 200,
    body: {
      server: '0.1.0', inbox: 0, config: { state: 'ok', problems: [] },
      domains: { 일상: { ...idle, agents_may_read: false }, 스터디: { ...idle, agents_may_read: true }, '미루기 아카이빙': { ...idle, agents_may_read: false } },
    },
  });
  const answer = { id: '01JB90A1C2D3E4F5G6H7J8K9MN', domain: '스터디', question: '질문?', answer: '답', cited: ['스터디/wiki/RAG'] };
  assert.deepEqual(await s.call('POST', '/answers', answer), { status: 422, body: { error: 'unprocessable', detail: 'cited page 스터디/wiki/RAG does not exist' } });
  assert.deepEqual(await s.call('POST', '/answers', { ...answer, cited: [] }), { status: 202, body: { id: answer.id, status: 'accepted' } });
  assert.equal((await s.call('GET', '/status')).body.domains.스터디.pending, 1);
  assert.deepEqual(await s.call('POST', '/jobs/retry', { domain: '스터디', kind: 'ingest', id: memoBody.id }), { status: 409, body: { error: 'conflict', detail: 'job has not given up' } });
  await s.close();
});

test('POST /chat streams SSE frames in order', async () => {
  const s = await serve(async function* () {
    yield { kind: 'session', sessionId: 's-1' };
    yield { kind: 'text', text: '청크 ' };
    yield { kind: 'text', text: '512' };
    yield { kind: 'done', sessionId: 's-1', cited: [{ domain: '스터디' as DomainName, page: 'RAG' }] };
  });
  const r = await s.call('POST', '/chat', { target: '스터디', message: 'RAG?' });
  assert.equal(r.status, 200);
  assert.equal(r.body, [
    'event: session\ndata: {"session_id":"s-1"}\n',
    'event: delta\ndata: {"text":"청크 "}\n',
    'event: delta\ndata: {"text":"512"}\n',
    'event: done\ndata: {"session_id":"s-1","cited":["스터디/wiki/RAG"]}\n',
    '',
  ].join('\n'));
  await s.close();
});

test('held memos: listed, counted in /status, confirmed or moved, with 404, 409, and 400 kept apart', async () => {
  const s = await serve();
  const unsure = { ...memoBody, domain_hint: null, text: `${'가'.repeat(300)}🙂` };
  const other = { ...unsure, id: '01JB90A1C2D3E4F5G6H7J8K9MN', captured_at: '2026-10-29T09:00:00+09:00', text: '짧은 메모' };
  s.llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  for (const m of [unsure, other]) {
    assert.equal((await s.call('POST', '/memos', m)).status, 201);
    assert.equal((await s.wiki.routeNext()).kind, 'held');
  }
  assert.deepEqual((await s.call('POST', '/memos', unsure)).body, { id: unsure.id, status: 'duplicate', state: 'held', domain: '스터디' });
  assert.equal((await s.call('GET', '/status')).body.domains.스터디.held, 2);

  const held = await s.call('GET', '/held');
  assert.equal(held.status, 200);
  assert.deepEqual(held.body.held.map((h: { id: string }) => h.id), [unsure.id, other.id], 'oldest captured first');
  assert.deepEqual({ ...held.body.held[0], text: held.body.held[0].text.length }, {
    id: unsure.id, domain: '스터디', text: 280, captured_at: unsure.captured_at, source: 'typed', confidence: 0.3, reason: '애매함',
  });

  assert.deepEqual(await s.call('POST', '/memos/01JB90A1C2D3E4F5G6H7J8K9ZZ/confirm'), { status: 404, body: { error: 'not_found', detail: 'no such memo' } });
  assert.equal((await s.call('POST', '/memos/..%2Fetc/confirm')).body.error, 'bad_request');
  assert.equal((await s.call('POST', '/memos/%E0%A4%A/confirm')).body.error, 'bad_request', 'malformed percent-encoding');
  assert.deepEqual(await s.call('POST', `/memos/${other.id}/move`, { domain: '없는도메인' }), { status: 400, body: { error: 'bad_request', detail: 'domain: not a domain' } });
  assert.deepEqual(await s.call('POST', `/memos/${other.id}/move`, { domain: '스터디' }), { status: 409, body: { error: 'conflict', detail: 'held' } }, 'already there');
  assert.equal((await s.call('POST', `/memos/${other.id}/nope`)).status, 404);

  assert.deepEqual(await s.call('POST', `/memos/${unsure.id.toUpperCase()}/confirm`), { status: 200, body: { id: unsure.id, status: 'released', domain: '스터디' } });
  assert.deepEqual(await s.call('POST', `/memos/${unsure.id}/confirm`), { status: 409, body: { error: 'conflict', detail: 'routed' } });
  assert.deepEqual(await s.call('POST', `/memos/${other.id}/move`, { domain: '일상' }), { status: 200, body: { id: other.id, status: 'released', domain: '일상' } });
  assert.deepEqual((await s.call('GET', '/held')).body, { held: [] });
  assert.deepEqual(await listDir(join(s.root, '스터디', 'raw')), [`${unsure.id}.md`]);
  assert.deepEqual(await listDir(join(s.root, '일상', 'raw')), [`${other.id}.md`]);

  assert.equal((await s.wiki.runNext('스터디' as DomainName)).kind, 'committed');
  assert.deepEqual(await s.call('POST', `/memos/${unsure.id}/move`, { domain: '일상' }), { status: 409, body: { error: 'conflict', detail: 'ingested' } });
  await s.close();
});

test('GET /memos pages newest first with an opaque cursor; GET /memos/:id describes one memo or 404s', async () => {
  const s = await serve();
  const at = (hhmm: string) => `2026-10-29T${hhmm}:00+09:00`;
  const ids = ['01JB90A1C2D3E4F5G6H7J8K9M1', '01JB90A1C2D3E4F5G6H7J8K9M2', '01JB90A1C2D3E4F5G6H7J8K9M3', '01JB90A1C2D3E4F5G6H7J8K9M4'];
  const long = `${'가'.repeat(150)}🙂`;
  await s.call('POST', '/memos', { ...memoBody, id: ids[0], captured_at: at('08:00'), text: long, location: { lat: 37.5, lon: 127.0, place: '성수', address: '서울특별시 성동구 성수동2가 273-5' } });
  assert.equal((await s.wiki.routeNext()).kind, 'routed');
  assert.equal((await s.wiki.runNext('스터디' as DomainName)).kind, 'committed');
  for (const [i, hhmm] of [[1, '09:00'], [2, '09:00'], [3, '10:00']] as const) {
    assert.equal((await s.call('POST', '/memos', { ...memoBody, id: ids[i], captured_at: at(hhmm), domain_hint: null })).status, 201);
  }

  const all = await s.call('GET', '/memos');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.memos.map((m: { id: string }) => m.id), [ids[3], ids[2], ids[1], ids[0]]);
  assert.equal(all.body.next_before, null);
  const ingested = all.body.memos[3];
  assert.match(ingested.finished_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.deepEqual({ ...ingested, finished_at: null }, {
    id: ids[0], text: '가'.repeat(140), captured_at: at('08:00'), tz: 'Asia/Seoul', source: 'typed', domain: '스터디', state: 'ingested',
    verdict: '새 페이지', first_page: `메모 ${ids[0]}`, finished_at: null,
  });
  assert.deepEqual(all.body.memos[0], {
    id: ids[3], text: memoBody.text, captured_at: at('10:00'), tz: 'Asia/Seoul', source: 'typed', domain: null, state: 'inbox',
    verdict: null, first_page: null, finished_at: null,
  });

  const seen: string[] = [];
  const cursors: (string | null)[] = [];
  let before: string | null = null;
  do {
    const r = await s.call('GET', `/memos?limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    seen.push(...r.body.memos.map((m: { id: string }) => m.id));
    before = r.body.next_before;
    cursors.push(before);
  } while (before);
  assert.deepEqual(seen, [ids[3], ids[2], ids[1], ids[0]], 'one page at a time reaches every memo once');
  assert.deepEqual(cursors, [at('10:00'), `${at('09:00')}|${ids[2]}`, at('09:00'), null], 'the id joins the cursor only when the next memo ties it');
  assert.deepEqual((await s.call('GET', `/memos?before=${at('09:00')}`)).body.memos.map((m: { id: string }) => m.id), [ids[0]], 'an unencoded + still parses');

  for (const q of ['limit=0', 'limit=101', 'limit=ten', 'before=yesterday', `before=${encodeURIComponent(`${at('09:00')}|nope`)}`]) {
    assert.equal((await s.call('GET', `/memos?${q}`)).body.error, 'bad_request', q);
  }

  const detail = await s.call('GET', `/memos/${ids[0]!.toLowerCase()}`);
  assert.equal(detail.status, 200);
  assert.deepEqual({ ...detail.body, finished_at: null }, {
    id: ids[0], text: long, captured_at: at('08:00'), tz: 'Asia/Seoul', source: 'typed', domain: '스터디', state: 'ingested',
    verdict: '새 페이지', first_page: `메모 ${ids[0]}`, finished_at: null, place: '성수',
    routing: { by: 'hint', confidence: null, reason: null },
    pages: [{ path: `메모 ${ids[0]}`, type: 'concept', change: 'created' }],
    failure: null,
  });
  assert.equal(detail.body.finished_at, ingested.finished_at);
  assert.match(await readFile(join(s.root, '스터디', 'raw', `${ids[0]}.md`), 'utf8'), /^  address: 서울특별시 성동구 성수동2가 273-5$/m, 'the raw memo keeps the full address; the detail shows only place');
  assert.equal((await s.call('POST', '/memos', { ...memoBody, id: ids[0]!.replace(/1$/, '9'), location: { lat: 37.5, lon: 127.0, address: 7 } })).body.error, 'bad_request');
  assert.deepEqual((await s.call('GET', `/memos/${ids[3]}`)).body.routing, null, 'an inbox memo has no routing yet');
  assert.deepEqual(await s.call('GET', '/memos/01JB90A1C2D3E4F5G6H7J8K9ZZ'), { status: 404, body: { error: 'not_found', detail: 'no such memo' } });
  assert.equal((await s.call('GET', '/memos/..%2Fetc')).body.error, 'bad_request');
  await s.close();
});

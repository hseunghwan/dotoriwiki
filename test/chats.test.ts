import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatOut, ChatTurn } from '../src/chat.ts';
import type { DomainName } from '../src/wiki/index.ts';
import { listDir, serveHttp, TOKEN } from './helpers.ts';

type Script = (turn: ChatTurn, signal: AbortSignal) => AsyncIterable<ChatOut>;

const SID = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

const answers = (sid: string, text: string, cited: string[] = []): Script =>
  async function* () {
    yield { kind: 'session', sessionId: sid };
    yield { kind: 'text', text };
    yield { kind: 'done', sessionId: sid, cited: cited.map((page) => ({ domain: '스터디' as DomainName, page })) };
  };

/** A fake chat that plays one script per turn and remembers the turns it was given. */
async function serve() {
  const queue: Script[] = [];
  const turns: ChatTurn[] = [];
  let clock = Date.parse('2026-10-29T00:00:00Z');
  const s = await serveHttp({
    chat: (turn, signal) => {
      turns.push(turn);
      const next = queue.shift();
      if (!next) throw new Error('no script left');
      return next(turn, signal);
    },
    now: () => new Date((clock += 60_000)),
  });
  const ask = (target: string, message: string, sessionId: string | null, script?: Script) => {
    if (script) queue.push(script);
    return s.call('POST', '/chat', { target, message, session_id: sessionId });
  };
  const lines = async (sid: string) => (await readFile(join(s.chatsDir, `${sid}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  return { ...s, queue, turns, ask, lines };
}

const at = (minutes: number) => new Date(Date.parse('2026-10-29T00:00:00Z') + minutes * 60_000).toISOString();

test('a chat is kept outside the wiki: meta once, a line per turn, and a resume runs on the stored target', async () => {
  const s = await serve();
  assert.equal((await s.ask('스터디', '첫 질문', null, answers(SID(1), '첫 답', ['RAG']))).status, 200);
  assert.equal((await s.ask('스터디', '둘째 질문', SID(1).toUpperCase(), answers(SID(1), '둘째 답'))).status, 200);
  assert.deepEqual(s.turns[1], { target: { kind: 'domain', domain: '스터디' }, message: '둘째 질문', sessionId: SID(1) }, 'the resume carries the session id');

  assert.deepEqual(await s.lines(SID(1)), [
    { type: 'meta', session_id: SID(1), target: '스터디', created_at: at(1) },
    { type: 'turn', at: at(2), question: '첫 질문', answer: '첫 답', cited: ['스터디/wiki/RAG'] },
    { type: 'turn', at: at(3), question: '둘째 질문', answer: '둘째 답', cited: [] },
  ], 'the resumed session frame does not write a second meta line');
  assert.deepEqual(await s.call('GET', `/chats/${SID(1)}`), {
    status: 200,
    body: {
      session_id: SID(1), target: '스터디', created_at: at(1),
      turns: [{ at: at(2), question: '첫 질문', answer: '첫 답', cited: ['스터디/wiki/RAG'] }, { at: at(3), question: '둘째 질문', answer: '둘째 답', cited: [] }],
    },
  });
  assert.deepEqual(await listDir(join(s.root, 'inbox')), [], 'nothing reached the wiki');
  await s.close();
});

test('a resume needs a known session on its own target with no turn in flight', async () => {
  const s = await serve();
  await s.ask('스터디', '질문', null, answers(SID(1), '답'));
  const called = s.turns.length;

  assert.deepEqual(await s.ask('스터디', '질문', SID(9)), { status: 404, body: { error: 'not_found', detail: 'no such chat' } });
  assert.deepEqual(await s.ask('일상', '질문', SID(1)), { status: 409, body: { error: 'conflict', detail: 'chat belongs to 스터디' } });
  assert.deepEqual(await s.ask('root', '질문', SID(1)), { status: 409, body: { error: 'conflict', detail: 'chat belongs to 스터디' } });

  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  s.queue.push(async function* () {
    yield { kind: 'session', sessionId: SID(1) };
    started();
    await gate;
    yield { kind: 'done', sessionId: SID(1), cited: [] };
  });
  const first = fetch(`${s.base}/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ target: '스터디', message: '느린 질문', session_id: SID(1) }),
  }).then((r) => r.text());
  await running;
  assert.deepEqual(await s.ask('스터디', '끼어든 질문', SID(1)), { status: 409, body: { error: 'conflict', detail: 'a turn on this chat is in flight' } });
  finish();
  await first;
  assert.equal(s.turns.length, called + 1, 'rejected requests never reach claude');
  assert.deepEqual((await s.call('GET', `/chats/${SID(1)}`)).body.turns.map((t: { question: string }) => t.question), ['질문', '느린 질문']);
  await s.close();
});

test('a turn that fails is kept as an error; a turn the client aborts is not kept', async () => {
  const s = await serve();
  await s.ask('스터디', '실패할 질문', null, async function* () {
    yield { kind: 'session', sessionId: SID(1) };
    yield { kind: 'text', text: '부분' };
    yield { kind: 'error', message: 'claude ended without a result' };
  });

  let aborted!: () => void;
  const sawAbort = new Promise<void>((r) => (aborted = r));
  s.queue.push(async function* (_turn, signal) {
    yield { kind: 'session', sessionId: SID(1) };
    yield { kind: 'text', text: '쓰는 중' };
    await new Promise((r) => signal.addEventListener('abort', r));
    aborted();
  });
  const abort = new AbortController();
  const res = await fetch(`${s.base}/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ target: '스터디', message: '버린 질문', session_id: SID(1) }), signal: abort.signal,
  });
  const reader = res.body!.getReader();
  let seen = '';
  while (!seen.includes('event: delta')) seen += new TextDecoder().decode((await reader.read()).value);
  abort.abort();
  await sawAbort;

  s.queue.push(answers(SID(1), '다음 답'));
  let r;
  do r = await s.ask('스터디', '다음 질문', SID(1));
  while (r.status === 409);
  assert.equal(r.status, 200, 'the aborted turn released the session');

  const turns = (await s.call('GET', `/chats/${SID(1)}`)).body.turns;
  assert.deepEqual(turns.map((t: { question: string; error?: string }) => [t.question, t.error ?? null]), [
    ['실패할 질문', 'claude ended without a result'],
    ['다음 질문', null],
  ]);
  await s.close();
});

test('GET /chats lists newest updated first with a cursor; DELETE /chats/:id removes the store file', async () => {
  const s = await serve();
  const long = `${'가'.repeat(45)}\n끝`;
  await s.ask('스터디', long, null, answers(SID(1), '답'));
  await s.ask('일상', '둘째 대화', null, answers(SID(2), '답'));
  await s.ask('root', '셋째 대화', null, answers(SID(3), '답'));
  await s.ask('스터디', '첫 대화 이어서', SID(1), answers(SID(1), '답'));

  const all = await s.call('GET', '/chats');
  assert.deepEqual(all.body.chats.map((c: { session_id: string }) => c.session_id), [SID(1), SID(3), SID(2)]);
  assert.equal(all.body.next_before, null);
  assert.deepEqual(all.body.chats[0], { session_id: SID(1), target: '스터디', title: `${'가'.repeat(39)}…`, created_at: at(1), updated_at: at(7), turns: 2 });

  const seen: string[] = [];
  let before: string | null = null;
  do {
    const r = await s.call('GET', `/chats?limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    seen.push(...r.body.chats.map((c: { session_id: string }) => c.session_id));
    before = r.body.next_before;
  } while (before);
  assert.deepEqual(seen, [SID(1), SID(3), SID(2)], 'one page at a time reaches every chat once');
  for (const q of ['limit=0', 'limit=101', 'before=yesterday', `before=${encodeURIComponent(`${at(1)}|nope`)}`]) {
    assert.equal((await s.call('GET', `/chats?${q}`)).body.error, 'bad_request', q);
  }

  assert.deepEqual(await s.call('DELETE', `/chats/${SID(3)}`), { status: 204, body: '' });
  assert.deepEqual(await s.call('GET', `/chats/${SID(3)}`), { status: 404, body: { error: 'not_found', detail: 'no such chat' } });
  assert.equal((await s.call('DELETE', `/chats/${SID(3)}`)).status, 404);
  assert.equal((await s.call('GET', '/chats/..%2Fetc')).body.error, 'bad_request');
  assert.deepEqual(await listDir(s.chatsDir), [`${SID(1)}.jsonl`, `${SID(2)}.jsonl`]);
  assert.deepEqual((await s.call('GET', '/chats')).body.chats.map((c: { session_id: string }) => c.session_id), [SID(1), SID(2)]);
  await s.close();
});

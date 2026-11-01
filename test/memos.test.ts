import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { DomainName, EditRequest, EditResult, MemoId, MemoSummary, Wiki } from '../src/wiki/index.ts';
import { fakeLlm, git, memo, modelWrites, open, page, rawIdOf, tempWiki, ulid, validFields, writesValidPage } from './helpers.ts';

const 스터디 = '스터디' as DomainName;
const 미루기 = '미루기 아카이빙' as DomainName;
const 일상 = '일상' as DomainName;

const TYPE_OF: Record<string, string> = { 스터디: 'concept', '미루기 아카이빙': 'item', 일상: 'me' };
const failsCheck = async (req: EditRequest): Promise<EditResult> => {
  await modelWrites(req, 'wiki/a.md', page(validFields(rawIdOf(req), { type: TYPE_OF[req.cwd.split('/').pop()!] }), '[[없음]]\n'));
  return { kind: 'finished', verdict: 'created', pages: [] };
};
const writesPageOfDomainType = async (req: EditRequest): Promise<EditResult> => {
  const id = rawIdOf(req);
  await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id, { type: TYPE_OF[req.cwd.split('/').pop()!] })));
  return { kind: 'finished', verdict: 'created', pages: [] };
};

async function routedTo(wiki: Wiki, n: number, d: DomainName) {
  await wiki.accept(memo(n, undefined, { domain_hint: d }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
}

/** Every commit from here on gets a new committer time, one minute later, so commits are told apart by time. */
let minute = 0;
const tick = () => (process.env.GIT_COMMITTER_DATE = `2026-10-29T12:${String(++minute).padStart(2, '0')}:00+09:00`);

/** Returns the committer time of the 포기 commit. */
async function giveUp(wiki: Wiki, llm: ReturnType<typeof fakeLlm>, d: DomainName): Promise<string> {
  llm.editWith = failsCheck;
  let at = '';
  for (const kind of ['retrying', 'retrying', 'gave-up']) {
    at = tick();
    assert.equal((await wiki.runNext(d)).kind, kind);
  }
  llm.editWith = writesPageOfDomainType;
  return at;
}
const rows = (list: readonly MemoSummary[]) => list.map((m) => [m.memo.id, m.state, m.domain]);
const writeMarker = (root: string, d: DomainName, id: string, attempt: number) =>
  fs.mkdir(join(root, '.gateway', 'inflight'), { recursive: true }).then(() =>
    fs.writeFile(join(root, '.gateway', 'inflight', `${d}.json`), JSON.stringify({
      job: { kind: 'ingest', domain: d, id }, base: git(root, 'rev-parse', 'HEAD').trim(), attempt, since: '2026-10-29T00:00:00.000Z', inputs: {},
    })));

test('every memo state is derived from the folders and the ledger, and a moved memo is listed once', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  llm.editWith = writesPageOfDomainType;
  const wiki = await open(root, llm);

  await routedTo(wiki, 1, 스터디);
  const ingestedAt = tick();
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await routedTo(wiki, 2, 일상);
  const gaveUpAt = await giveUp(wiki, llm, 일상);
  await routedTo(wiki, 3, 일상);
  await giveUp(wiki, llm, 일상);
  assert.equal((await wiki.move(ulid(3) as MemoId, 미루기)).kind, 'released');
  await routedTo(wiki, 4, 스터디);
  llm.editWith = failsCheck;
  assert.equal((await wiki.runNext(스터디)).kind, 'retrying');
  await routedTo(wiki, 5, 일상);
  await giveUp(wiki, llm, 일상);
  assert.equal((await wiki.retry({ kind: 'ingest', domain: 일상, id: ulid(5) })).kind, 'retrying');
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  await wiki.accept(memo(6));
  assert.equal((await wiki.routeNext()).kind, 'held');
  await wiki.accept(memo(7));

  const list = await wiki.memos({ limit: 100, before: null });
  assert.deepEqual(rows(list), [
    [ulid(7), 'inbox', null],
    [ulid(6), 'held', 스터디],
    [ulid(5), 'routed', 일상],
    [ulid(4), 'routed', 스터디],
    [ulid(3), 'routed', 미루기],
    [ulid(2), 'failed', 일상],
    [ulid(1), 'ingested', 스터디],
  ]);
  assert.deepEqual(list.at(-1), {
    memo: memo(1, undefined, { domain_hint: 스터디 }), state: 'ingested', domain: 스터디, verdict: { id: 'created', text: '새 페이지' }, firstPage: `메모 ${ulid(1)}`,
    finishedAt: ingestedAt,
  });
  assert.deepEqual(list.at(-2), { memo: memo(2, undefined, { domain_hint: 일상 }), state: 'failed', domain: 일상, finishedAt: gaveUpAt });

  assert.deepEqual((await wiki.memo(ulid(2) as MemoId))!.failure, { attempts: 3, max: 3, code: 'broken-link', detail: '일상/wiki/a.md: [[없음]] does not resolve' });
  assert.equal((await wiki.memo(ulid(5) as MemoId))!.failure, null, 'a retried memo starts its attempts over');
  assert.deepEqual((await wiki.memo(ulid(4) as MemoId))!.failure, { attempts: 1, max: 3, code: 'broken-link', detail: '스터디/wiki/a.md: [[없음]] does not resolve' });
  assert.deepEqual((await wiki.memo(ulid(3) as MemoId))!.routing, { by: 'user', from: 일상, previous: { by: 'hint' } });
  assert.deepEqual((await wiki.memo(ulid(6) as MemoId))!.routing, { by: 'classifier', confidence: 0.3, reason: '애매함' });
  assert.equal((await wiki.memo(ulid(7) as MemoId))!.routing, null);
  assert.equal(await wiki.memo(ulid(99) as MemoId), null);

  await writeMarker(root, 스터디, ulid(4), 2);
  const running = (await wiki.memo(ulid(4) as MemoId))!;
  assert.deepEqual([running.state, running.failure?.attempts], ['running', 1], 'mid-run, with the earlier failure');
  assert.deepEqual(await wiki.accept(memo(4)), { kind: 'duplicate', state: 'running', domain: 스터디 });

  llm.editWith = async () => ({ kind: 'unavailable', reason: 'rate limited', retryAfterMs: 1 });
  assert.equal((await wiki.runNext(스터디)).kind, 'unavailable');
  const interrupted = (await wiki.memo(ulid(4) as MemoId))!;
  assert.deepEqual([interrupted.state, interrupted.failure], ['routed', { attempts: 2, max: 3, code: 'interrupted', detail: 'gateway stopped mid-job' }]);
  delete process.env.GIT_COMMITTER_DATE;
  await wiki.close();
});

test('pagination: newest captured first, ties broken by id, and a cursor unmoved by a newer memo', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  const tie = '2026-10-29T08:30:00+09:00';
  for (const n of [1, 2]) await wiki.accept(memo(n));
  for (const n of [3, 4]) await wiki.accept(memo(n, undefined, { captured_at: tie }));
  await wiki.accept(memo(5, undefined, { captured_at: '2026-10-29T08:40:00+09:00' }));
  // 08:31 KST written in UTC: ordered by instant, not by string.
  await wiki.accept(memo(6, undefined, { captured_at: '2026-10-28T23:31:00Z' }));

  const ids = (l: readonly MemoSummary[]) => l.map((m) => m.memo.id);
  assert.deepEqual(ids(await wiki.memos({ limit: 10, before: null })), [ulid(5), ulid(6), ulid(4), ulid(3), ulid(2), ulid(1)]);
  const first = await wiki.memos({ limit: 3, before: null });
  assert.deepEqual(ids(first), [ulid(5), ulid(6), ulid(4)]);
  const cursor = { capturedAt: first[2]!.memo.capturedAt, id: first[2]!.memo.id };
  await wiki.accept(memo(9, undefined, { captured_at: '2026-10-29T09:30:00+09:00' }));
  assert.deepEqual(ids(await wiki.memos({ limit: 3, before: cursor })), [ulid(3), ulid(2), ulid(1)], 'the tied memo with the lower id comes next');
  assert.deepEqual(ids(await wiki.memos({ limit: 3, before: { capturedAt: tie, id: null } })), [ulid(2), ulid(1)], 'a bare time excludes the whole instant');
  assert.equal((await wiki.memos({ limit: 1, before: null }))[0]!.memo.id, ulid(9));
  await wiki.close();
});

test('detail pages: created and modified by the ingest commit, with each type at that commit', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  llm.editWith = writesValidPage(() => 'RAG');
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await routedTo(wiki, 2, 스터디);
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, 'wiki/RAG.md', page(validFields(id), '고친 본문.\n'));
    await modelWrites(req, 'wiki/인사이트/청크.md', page({ ...validFields(id), type: 'insight' }));
    return { kind: 'finished', verdict: 'updated', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await fs.writeFile(join(root, '스터디', 'wiki', 'RAG.md'), page({ ...validFields('x'), type: 'case' }));
  await routedTo(wiki, 3, 스터디);
  llm.editWith = async () => ({ kind: 'finished', verdict: 'unchanged', pages: [] });
  assert.equal((await wiki.runNext(스터디)).kind, 'committed', 'a later manual commit retypes RAG');

  assert.deepEqual((await wiki.memo(ulid(1) as MemoId))!.pages, [{ path: 'RAG', type: 'concept', change: 'created' }]);
  const second = (await wiki.memo(ulid(2) as MemoId))!;
  assert.deepEqual(second.pages, [
    { path: 'RAG', type: 'concept', change: 'modified' },
    { path: '인사이트/청크', type: 'insight', change: 'created' },
  ]);
  assert.deepEqual([second.state === 'ingested' && second.verdict, second.state === 'ingested' && second.firstPage], [{ id: 'updated', text: '기존 페이지 수정' }, 'RAG']);
  assert.deepEqual((await wiki.memo(ulid(3) as MemoId))!.pages, []);
  await wiki.close();
});

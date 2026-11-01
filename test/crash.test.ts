/**
 * Crash safety against a real temp git repo and a fake Llm. Each test stops the transaction at
 * one point, by throwing from the fake or by recreating the exact folder state a kill would
 * leave, then reopens the Wiki and asserts from the folder alone that nothing was lost and
 * nothing was applied twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { DomainName, MemoId, Wiki } from '../src/wiki/index.ts';
import { fakeFetch, fakeLlm, git, headFile, ledgerLines, listDir, memo, modelWrites, open, page, rawIdOf, readText, tempWiki, ulid, validFields, writesValidPage, type FakeLlm } from './helpers.ts';

const 스터디 = '스터디' as DomainName;
const outcomes = (root: string, id: string) => ledgerLines(root, '스터디').filter((l) => l.includes(` | ${id} | `)).map((l) => l.split(' | ')[2]);
const kill = () => {
  throw new Error('kill -9');
};

async function restart(root: string, wiki: Wiki, llm: FakeLlm): Promise<Wiki> {
  await wiki.close();
  return open(root, llm);
}

async function routed(root: string, llm: FakeLlm, n: number): Promise<Wiki> {
  const wiki = await open(root, llm);
  await wiki.accept(memo(n, `메모 ${n}`, { domain_hint: '스터디' }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  return wiki;
}

function assertAppliedOnce(root: string, id: string) {
  assert.equal(outcomes(root, id).filter((o) => o === '새 페이지').length, 1, 'exactly one applied line');
  assert.ok(headFile(root, `스터디/raw/${id}.md`), 'raw memo committed');
  assert.ok(headFile(root, `스터디/wiki/메모 ${id}.md`), 'page committed');
  assert.equal(git(root, 'status', '--porcelain', '--', '스터디'), '', 'domain clean');
}

test('accept: killed after the tmp write, before link()', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await open(root, llm);
  await fs.writeFile(join(root, 'inbox', `.tmp-${ulid(1)}.md-deadbeef`), 'half');
  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await fs.readdir(join(root, 'inbox')).then((n) => n.filter((x) => x.startsWith('.tmp-'))), [], 'orphan swept on open');
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'created' }, 'resend creates it');
  assert.deepEqual(await listDir(join(root, 'inbox')), [`${ulid(1)}.md`]);
  await wiki.close();
});

test('routeNext: killed mid-classify, then after the raw/ link and before the inbox unlink', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await open(root, llm);
  await wiki.accept(memo(1));
  const inboxCopy = (await readText(join(root, 'inbox', `${ulid(1)}.md`)))!;
  llm.classifyWith = async () => kill();
  await assert.rejects(wiki.routeNext(), /kill/);
  assert.deepEqual(await listDir(join(root, 'inbox')), [`${ulid(1)}.md`], 'memo still in the inbox');

  wiki = await restart(root, wiki, llm);
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.9, reason: 'fake' });
  assert.equal((await wiki.routeNext()).kind, 'routed');
  await fs.writeFile(join(root, 'inbox', `${ulid(1)}.md`), inboxCopy);
  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.routeNext(), { kind: 'dropped-duplicate', id: ulid(1) });
  assert.deepEqual(await listDir(join(root, 'inbox')), []);
  assert.equal(llm.classifyCalls.length, 2, 'the finished route is not classified again');
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

test('runNext: killed mid-edit with a half-written page', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await routed(root, llm, 1);
  llm.editWith = async (req) => {
    await modelWrites(req, `wiki/메모 ${rawIdOf(req)}.md`, '---\ntype: con');
    await modelWrites(req, 'wiki/고아.md', 'half');
    return kill();
  };
  await assert.rejects(wiki.runNext(스터디), /kill/);
  assert.ok(await readText(join(root, '.gateway', 'inflight', '스터디.json')), 'marker left behind');

  wiki = await restart(root, wiki, llm);
  llm.editWith = async (req) => {
    assert.equal(await readText(join(req.cwd, 'wiki', '고아.md')), null, 'half-written leftovers are gone before the rerun');
    await modelWrites(req, `wiki/메모 ${rawIdOf(req)}.md`, page(validFields(rawIdOf(req))));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(outcomes(root, ulid(1)), ['중단 1/3', '새 페이지']);
  assertAppliedOnce(root, ulid(1));
  assert.equal(headFile(root, '스터디/wiki/고아.md'), null);
  await wiki.close();
});

test('runNext: killed after the ledger line was written and staged, before git commit finished', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await routed(root, llm, 1);
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id)));
    await fs.appendFile(join(req.cwd, 'wiki', 'log.md'), `## [2026-10-29] ingest | ${id} | 새 페이지 | 메모 ${id}.md\n`);
    git(root, 'add', '-A', '--', '스터디/wiki', `스터디/raw/${id}.md`);
    await fs.writeFile(join(root, '.git', 'index.lock'), '');
    return kill();
  };
  await assert.rejects(wiki.runNext(스터디), /kill/);

  wiki = await restart(root, wiki, llm);
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id)));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed', 'stale index.lock cleared on open, staged leftovers reset');
  assert.deepEqual(outcomes(root, ulid(1)), ['중단 1/3', '새 페이지'], 'the uncommitted ledger line counted for nothing');
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

test('runNext: killed after the commit, before the marker was cleared', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await routed(root, llm, 1);
  let marker = '';
  const write = llm.editWith;
  llm.editWith = async (req) => {
    marker = (await readText(join(root, '.gateway', 'inflight', '스터디.json')))!;
    return write(req);
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await fs.writeFile(join(root, '.gateway', 'inflight', '스터디.json'), marker);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'recovery only clears the marker');
  assert.equal(llm.editCalls.length, 1, 'no rerun');
  assert.deepEqual(outcomes(root, ulid(1)), ['새 페이지'], 'no 중단 line');
  assert.equal(await readText(join(root, '.gateway', 'inflight', '스터디.json')), null);
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

test('runNext: killed after a failed attempt was committed, before the marker was cleared', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await routed(root, llm, 1);
  let marker = '';
  llm.editWith = async (req) => {
    marker = (await readText(join(root, '.gateway', 'inflight', '스터디.json')))!;
    await modelWrites(req, 'wiki/a.md', '');
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'retrying');
  await fs.writeFile(join(root, '.gateway', 'inflight', '스터디.json'), marker);

  wiki = await restart(root, wiki, llm);
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id)));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(outcomes(root, ulid(1)), ['실패 1/3', '새 페이지'], 'the committed 실패 line is not doubled by a 중단 line');
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

test('runNext: a job that kills the gateway every time stops after maxAttempts', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await routed(root, llm, 1);
  llm.editWith = async () => kill();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(wiki.runNext(스터디), /kill/);
    wiki = await restart(root, wiki, llm);
  }
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'third recovery gives up instead of rerunning');
  assert.deepEqual(outcomes(root, ulid(1)), ['중단 1/3', '중단 2/3', '포기 3/3']);
  assert.match(headFile(root, '스터디/wiki/_review.md')!, /포기 3\/3: gateway stopped mid-job/);
  assert.ok(headFile(root, `스터디/raw/${ulid(1)}.md`), 'the memo is kept in git, not lost');

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'no further attempts after reopen');
  assert.equal(llm.editCalls.length, 3);
  await wiki.close();
});

test('runNext: Unavailable spends no attempt and leaves wiki/ clean', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await routed(root, llm, 1);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/partial.md', 'x');
    return { kind: 'unavailable', reason: 'usage limit', retryAfterMs: 60_000 };
  };
  const r = await wiki.runNext(스터디);
  assert.equal(r.kind, 'unavailable');
  assert.deepEqual(outcomes(root, ulid(1)), [], 'no ledger line');
  assert.equal(git(root, 'status', '--porcelain', '--', '스터디/wiki'), '', 'wiki/ clean');
  assert.equal(await readText(join(root, '.gateway', 'inflight', '스터디.json')), null, 'no marker');
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id)));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(outcomes(root, ulid(1)), ['새 페이지'], 'first real attempt');
  await wiki.close();
});

test('file-answer: killed after the commit, before the staging file was unlinked', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await open(root, llm);
  const filing = { id: ulid(5) as never, domain: 스터디, question: '질문?', answer: '답.', cited: [], sessionId: 's', askedAt: '2026-10-29T09:00:00.000Z' };
  assert.deepEqual(await wiki.fileAnswer(filing), { kind: 'created' });
  const staged = join(root, 'inbox', 'answers', '스터디', `${ulid(5)}.md`);
  const content = (await readText(staged))!;
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await fs.writeFile(staged, content);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  assert.equal(await readText(staged), null, 'pick finished the unlink');
  assert.deepEqual(await listDir(join(root, '스터디', 'wiki', 'answers')), ['2026-10-29 질문.md'], 'no second answer file');
  assert.equal(ledgerLines(root, '스터디').filter((l) => l.includes(ulid(5))).length, 1);
  await wiki.close();
});

test('runNext: killed after the sidecar was written, before the LLM ran', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const fetch = fakeFetch();
  let wiki = await open(root, llm, { fetchSource: fetch });
  await wiki.accept(memo(1, '읽어볼 글 https://example.com/post', { domain_hint: '스터디' }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  llm.editWith = async () => kill();
  await assert.rejects(wiki.runNext(스터디), /kill/);
  const sidecar = join(root, '스터디', 'raw', `${ulid(1)}.source.md`);
  const written = await readText(sidecar);
  assert.ok(written, 'sidecar written before the kill');

  await wiki.close();
  wiki = await open(root, llm, { fetchSource: fetch });
  llm.editWith = writesValidPage();
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(fetch.calls, ['https://example.com/post'], 'reused, not refetched');
  assert.deepEqual(outcomes(root, ulid(1)), ['중단 1/3', '새 페이지']);
  assert.equal(headFile(root, `스터디/raw/${ulid(1)}.source.md`), written, 'the first sidecar is the one committed');
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

async function heldMemo(root: string, llm: FakeLlm, n: number): Promise<Wiki> {
  const wiki = await open(root, llm);
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  await wiki.accept(memo(n));
  assert.equal((await wiki.routeNext()).kind, 'held');
  return wiki;
}

/** Every place a memo can sit outside the inbox, as `<domain>/<folder>`. */
async function placesOf(root: string, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of ['미루기 아카이빙', '스터디', '일상']) {
    for (const f of ['raw', 'hold']) if (await readText(join(root, d, f, `${id}.md`))) out.push(`${d}/${f}`);
  }
  return out;
}

test('routeNext: killed after the hold/ link, before the inbox unlink', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await open(root, llm);
  await wiki.accept(memo(1));
  const inboxCopy = (await readText(join(root, 'inbox', `${ulid(1)}.md`)))!;
  await wiki.close();
  wiki = await heldMemo(root, llm, 1);
  await fs.writeFile(join(root, 'inbox', `${ulid(1)}.md`), inboxCopy);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.routeNext(), { kind: 'dropped-duplicate', id: ulid(1) });
  assert.deepEqual(await placesOf(root, ulid(1)), ['스터디/hold']);
  assert.equal(llm.classifyCalls.length, 1, 'not classified again');
  await wiki.close();
});

test('confirm: killed after the raw/ link, before the hold/ unlink', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await heldMemo(root, llm, 1);
  const holdFile = join(root, '스터디', 'hold', `${ulid(1)}.md`);
  const holdCopy = (await readText(holdFile))!;
  assert.equal((await wiki.confirm(ulid(1) as MemoId)).kind, 'released');
  await fs.writeFile(holdFile, holdCopy);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.held(), [], 'the raw copy wins');
  assert.deepEqual(await placesOf(root, ulid(1)), ['스터디/raw'], 'the scan removed the hold leftover');
  assert.deepEqual(await wiki.confirm(ulid(1) as MemoId), { kind: 'conflict', state: 'routed', domain: 스터디 });
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  assertAppliedOnce(root, ulid(1));
  await wiki.close();
});

const 미루기 = '미루기 아카이빙' as DomainName;
const itemPage = async (req: Parameters<FakeLlm['editWith']>[0]) => {
  const id = rawIdOf(req);
  await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id, { type: 'item' })));
  return { kind: 'finished', verdict: 'created', pages: [] } as const;
};

async function gaveUp(root: string, llm: FakeLlm, n: number, text: string, fetch = fakeFetch()): Promise<Wiki> {
  const wiki = await open(root, llm, { fetchSource: fetch });
  await wiki.accept(memo(n, text, { domain_hint: '스터디' }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/a.md', '');
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  for (const kind of ['retrying', 'retrying', 'gave-up']) assert.equal((await wiki.runNext(스터디)).kind, kind);
  llm.editWith = itemPage;
  return wiki;
}

function assertMovedOnce(root: string, id: string) {
  assert.equal(ledgerLines(root, '스터디').filter((l) => l.includes(` | ${id} | 이동 → 미루기 아카이빙 | `)).length, 1, 'one 이동 line');
  assert.equal(headFile(root, `스터디/raw/${id}.md`), null, 'gone from the source domain');
  assert.equal(git(root, 'status', '--porcelain', '--', '스터디'), '', 'source domain clean');
  assert.equal(ledgerLines(root, '미루기 아카이빙').filter((l) => l.includes(` | ${id} | 새 페이지 | `)).length, 1, 'ingested once in the new domain');
}

test('move (held): killed after the raw/ link, before the hold/ unlink', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await heldMemo(root, llm, 1);
  const holdFile = join(root, '스터디', 'hold', `${ulid(1)}.md`);
  const holdCopy = (await readText(holdFile))!;
  assert.equal((await wiki.move(ulid(1) as MemoId, 미루기)).kind, 'released');
  await fs.writeFile(holdFile, holdCopy);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'duplicate', state: 'routed', domain: 미루기 }, 'the raw copy wins');
  assert.deepEqual(await wiki.held(), []);
  assert.deepEqual(await placesOf(root, ulid(1)), ['미루기 아카이빙/raw']);
  llm.editWith = itemPage;
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  await wiki.close();
});

test('move (gave-up): killed after the memo was placed, before the source commit', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  let wiki = await gaveUp(root, llm, 1, '메모 1');
  assert.equal((await wiki.move(ulid(1) as MemoId, 미루기)).kind, 'released');
  git(root, 'reset', '-q', '--hard', 'HEAD~1');
  assert.deepEqual(await placesOf(root, ulid(1)), ['미루기 아카이빙/raw', '스터디/raw'], 'the kill-point state: placed, not yet committed');

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'duplicate', state: 'routed', domain: 미루기 }, 'the failed copy loses');
  assert.deepEqual(await wiki.retry({ kind: 'ingest', domain: 스터디, id: ulid(1) }), { kind: 'not-failed' }, 'no retry of a half-moved memo');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'the source lane finishes the move');
  assert.deepEqual(await placesOf(root, ulid(1)), ['미루기 아카이빙/raw']);
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assertMovedOnce(root, ulid(1));
  assert.deepEqual((await wiki.status()).domains.map((d) => d.failed), [0, 0, 0]);
  await wiki.close();
});

test('move (gave-up): killed after the sidecar was placed, before the memo', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const fetch = fakeFetch();
  let wiki = await gaveUp(root, llm, 1, '읽어볼 글 https://example.com/post', fetch);
  const sidecar = (await readText(join(root, '스터디', 'raw', `${ulid(1)}.source.md`)))!;
  await fs.writeFile(join(root, '미루기 아카이빙', 'raw', `${ulid(1)}.source.md`), sidecar);

  wiki = await restart(root, wiki, llm);
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'nothing to finish: the memo was never placed');
  assert.deepEqual(await placesOf(root, ulid(1)), ['스터디/raw'], 'still failed in place');
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 미루기), { kind: 'released', domain: 미루기 }, 'the move is reissued');
  wiki = await restart(root, wiki, llm);
  llm.editWith = itemPage;
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assert.deepEqual(fetch.calls, ['https://example.com/post'], 'never refetched');
  assertMovedOnce(root, ulid(1));
  await wiki.close();
});

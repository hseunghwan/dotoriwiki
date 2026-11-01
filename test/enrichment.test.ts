/** Link enrichment inside runNext, against a temp repo, a fake Llm, and a fake FetchSource. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseSourceFile, type DomainName, type EditRequest } from '../src/wiki/index.ts';
import { fakeFetch, fakeLlm, git, headFile, ledgerLines, memo, modelWrites, open, page, rawIdOf, readText, tempWiki, ulid, validFields } from './helpers.ts';

const 미루기 = '미루기 아카이빙' as DomainName;
const LINKS = '이 영상 꼭 봐야지 https://youtu.be/abc\n원문: https://example.com/post\n토론: https://news.hada.io/topic?id=1';
const sidecarRel = (id: string) => `미루기 아카이빙/raw/${id}.source.md`;

async function writesItem(req: EditRequest) {
  const id = rawIdOf(req);
  await modelWrites(req, `wiki/항목 ${id}.md`, page(validFields(id, { type: 'item' })));
  return { kind: 'finished', verdict: 'created', pages: [] } as const;
}

async function setup(text = LINKS) {
  const root = await tempWiki();
  const llm = fakeLlm();
  llm.editWith = writesItem;
  const fetch = fakeFetch();
  const wiki = await open(root, llm, { fetchSource: fetch });
  await wiki.accept(memo(1, text, { domain_hint: '미루기 아카이빙' }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  return { root, llm, fetch, wiki };
}

test('a link memo gets raw/<id>.source.md before the LLM runs; the prompt names it and the job commits it', async () => {
  const { root, llm, fetch, wiki } = await setup();
  fetch.respond = async (url) => (url.includes('youtu')
    ? { kind: 'video', status: 'ok', title: '영상', text: '제목: 영상\n\n자막 (ko, 자동):\n안녕하세요' }
    : { kind: 'article', status: 'failed', title: null, detail: 'HTTP 404' });
  let sidecarAtEdit: string | null = null;
  llm.editWith = async (req: EditRequest) => {
    sidecarAtEdit = await readText(join(req.cwd, 'raw', `${rawIdOf(req)}.source.md`));
    return writesItem(req);
  };
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assert.deepEqual(fetch.calls, ['https://youtu.be/abc', 'https://example.com/post'], 'the 토론 link is not fetched');
  assert.ok(sidecarAtEdit, 'sidecar on disk when the LLM ran');
  assert.match(llm.editCalls[0]!.prompt, new RegExp(`raw/${ulid(1)}\\.source\\.md`));
  const committed = headFile(root, sidecarRel(ulid(1)));
  assert.equal(committed, sidecarAtEdit, 'committed as written');
  const parsed = parseSourceFile(committed!);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.memo, ulid(1));
  assert.equal(parsed.value.fetchedAt, '2026-10-29T09:00:00+09:00');
  assert.deepEqual(parsed.value.sources, [
    { url: 'https://youtu.be/abc', kind: 'video', status: 'ok', title: '영상', text: '제목: 영상\n\n자막 (ko, 자동):\n안녕하세요' },
    { url: 'https://example.com/post', kind: 'article', status: 'failed', title: null, detail: 'HTTP 404' },
  ]);
  assert.equal(git(root, 'status', '--porcelain', '--', '미루기 아카이빙'), '', 'domain clean');
  await wiki.close();
});

test('a memo without links is not fetched and gets no sidecar', async () => {
  const { root, llm, fetch, wiki } = await setup('주말에 도자기 공방 가보고 싶다');
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assert.deepEqual(fetch.calls, []);
  assert.doesNotMatch(llm.editCalls[0]!.prompt, /source\.md/);
  assert.equal(await readText(join(root, sidecarRel(ulid(1)))), null);
  await wiki.close();
});

test('a failed attempt keeps the sidecar; retries reuse it, and giving up commits it with the memo', async () => {
  const { root, llm, fetch, wiki } = await setup();
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/빈.md', '');
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(미루기)).kind, 'retrying');
  const first = await readText(join(root, sidecarRel(ulid(1))));
  assert.ok(first, 'rollback leaves raw/ alone');
  assert.equal((await wiki.runNext(미루기)).kind, 'retrying');
  assert.equal((await wiki.runNext(미루기)).kind, 'gave-up');
  assert.equal(fetch.calls.length, 2, 'fetched once for two links, across three attempts');
  assert.equal(headFile(root, sidecarRel(ulid(1))), first);
  assert.ok(headFile(root, `미루기 아카이빙/raw/${ulid(1)}.md`));
  await wiki.close();
});

test('a fetcher that throws fails the attempt like any other error, and the next attempt fetches again', async () => {
  const { root, llm, fetch, wiki: first } = await setup();
  fetch.respond = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(first.runNext(미루기), /disk full/);
  assert.equal(await readText(join(root, sidecarRel(ulid(1)))), null, 'no partial sidecar');
  await first.close();
  const fetch2 = fakeFetch();
  const wiki = await open(root, llm, { fetchSource: fetch2 });
  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  const outcomes = ledgerLines(root, '미루기 아카이빙').map((l) => l.split(' | ')[2]);
  assert.deepEqual(outcomes, ['중단 1/3', '새 페이지']);
  assert.equal(fetch2.calls.length, 2);
  assert.ok(headFile(root, sidecarRel(ulid(1))));
  await wiki.close();
});

test('the model changing the sidecar fails the attempt as a modified input', async () => {
  const { llm, wiki } = await setup();
  llm.editWith = async (req) => {
    await modelWrites(req, `raw/${rawIdOf(req)}.source.md`, 'rewritten');
    return writesItem(req);
  };
  const r = await wiki.runNext(미루기);
  assert.equal(r.kind, 'retrying');
  assert.ok(r.kind === 'retrying' && r.problems.some((p) => p.rule === 'input-modified' && p.path.endsWith('.source.md')));
  await wiki.close();
});

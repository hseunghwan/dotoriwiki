import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { DomainName, EditRequest, EditResult, MemoId, RunReport, Wiki } from '../src/wiki/index.ts';
import {
  commitSubjects, fakeFetch, fakeLlm, git, headFile, ledgerLines, listDir, memo, modelWrites, open, page, rawIdOf, readText, tempWiki,
  ulid, validFields, writesValidPage,
} from './helpers.ts';

const 스터디 = '스터디' as DomainName;
const 미루기 = '미루기 아카이빙' as DomainName;
const 일상 = '일상' as DomainName;

async function routedTo(wiki: Wiki, n: number, d: DomainName, text?: string) {
  await wiki.accept(memo(n, text, { domain_hint: d }));
  const r = await wiki.routeNext();
  assert.equal(r.kind, 'routed', 'memo routed by hint');
}

const problemRules = (r: RunReport) => (r.kind === 'retrying' || r.kind === 'gave-up' ? r.problems.map((p) => p.rule) : []);

test('openWiki commits the config and init(<d>) for each domain, and generates an empty index', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  assert.deepEqual(commitSubjects(root), ['manual(config)', 'init(일상)', 'init(스터디)', 'init(미루기 아카이빙)']);
  assert.equal(headFile(root, '미루기 아카이빙/wiki/log.md'), '# log\n');
  assert.match(headFile(root, '스터디/wiki/index.md')!, /^# 스터디 색인/);
  assert.equal(headFile(root, '스터디/raw/.gitkeep'), '', 'raw/.gitkeep is tracked, so raw/ holds only memos');
  await wiki.close();
  const again = await open(root, fakeLlm());
  assert.equal(commitSubjects(root).length, 4, 'reopening commits nothing');
  await again.close();
});

test('openWiki refuses a root without dotoriwiki.yaml or with a newer version; a folder the file does not name is not a domain', async () => {
  const missing = await tempWiki();
  await fs.rm(join(missing, 'dotoriwiki.yaml'));
  await assert.rejects(open(missing, fakeLlm()), /not a dotoriwiki wiki/);

  const newer = await tempWiki();
  await fs.writeFile(join(newer, 'dotoriwiki.yaml'), (await fs.readFile(join(newer, 'dotoriwiki.yaml'), 'utf8')).replace('version: 1', 'version: 2'));
  await assert.rejects(open(newer, fakeLlm()), /version is 2/);

  const extra = await tempWiki();
  await fs.mkdir(join(extra, '새 도메인'));
  await fs.writeFile(join(extra, '새 도메인', 'CLAUDE.md'), '# 새 도메인\n');
  const wiki = await open(extra, fakeLlm());
  assert.deepEqual([...(await wiki.config()).domains.keys()], ['일상', '스터디', '미루기 아카이빙']);
  await wiki.close();
});

test('one gateway per root; a lock left by a dead process is taken over', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  await assert.rejects(open(root, fakeLlm()), /locked/, 'second open while the first holds the lock');
  await wiki.close();

  const dead = spawnSync('true').pid!;
  await fs.writeFile(join(root, '.gateway', 'lock'), JSON.stringify({ pid: dead, started: 'Thu Jan  1 00:00:00 1970' }));
  const w2 = await open(root, fakeLlm());
  await w2.close();
  await fs.writeFile(join(root, '.gateway', 'lock'), JSON.stringify({ pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' }));
  const w3 = await open(root, fakeLlm());
  await w3.close();
});

test('routing: hint, classifier, low confidence held, fallback held after two empty answers', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);

  await wiki.accept(memo(1, '힌트 메모', { domain_hint: '미루기 아카이빙' }));
  assert.deepEqual(await wiki.routeNext(), { kind: 'routed', id: ulid(1), domain: 미루기, routing: { by: 'hint' } });
  assert.equal(llm.classifyCalls.length, 0, 'a valid hint skips the classifier');

  await wiki.accept(memo(2, '없는 힌트', { domain_hint: '없는도메인' }));
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  const r2 = await wiki.routeNext();
  assert.deepEqual(r2, { kind: 'held', id: ulid(2), domain: 스터디, routing: { by: 'classifier', confidence: 0.3, reason: '애매함' } });
  assert.deepEqual(llm.classifyCalls[0]!.domains, ['일상', '스터디', '미루기 아카이빙'], 'the schema enum is the declared domain list');

  await wiki.accept(memo(3));
  llm.classifyWith = async () => ({ kind: 'no-answer', detail: 'no structured_output' });
  assert.deepEqual(await wiki.routeNext(), { kind: 'held', id: ulid(3), domain: 일상, routing: { by: 'fallback', reason: 'no structured_output' } });
  assert.equal(llm.classifyCalls.length, 3, 'one retry before falling back');
  assert.match((await readText(join(root, '일상', 'hold', `${ulid(3)}.md`)))!, /routing:\n {2}by: fallback/);
  assert.deepEqual(await listDir(join(root, 'inbox')), [], 'inbox drained');

  await wiki.accept(memo(4, '확신 메모'));
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.6, reason: '분명함' });
  assert.equal((await wiki.routeNext()).kind, 'routed', 'confidence at the threshold is not held');
  await wiki.close();
});

test('an agent memo keeps its context in the raw file, and the classifier sees the project and branch', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const context = { project: 'notes-app', cwd: '/Users/me/workspace/notes-app', branch: 'main' };
  await wiki.accept(memo(1, 'RRF 상수 60', { source: 'agent', context }));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  assert.equal(llm.classifyCalls[0]!.text, 'RRF 상수 60\n\n작성 맥락: 프로젝트 notes-app, 브랜치 main');
  const raw = (await readText(join(root, '스터디', 'raw', `${ulid(1)}.md`)))!;
  assert.match(raw, /\nsource: agent\n/);
  assert.match(raw, /\ncontext:\n {2}project: notes-app\n {2}cwd: \/Users\/me\/workspace\/notes-app\n {2}branch: main\n/);

  await wiki.accept(memo(2, '폰 메모'));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  assert.equal(llm.classifyCalls[1]!.text, '폰 메모', 'no context, no context line');
  assert.doesNotMatch((await readText(join(root, '스터디', 'raw', `${ulid(2)}.md`)))!, /context:/);
  await wiki.close();
});

test('a held memo is never picked, keeps out of manual commits, and is ingested once after confirm', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  await wiki.accept(memo(1, '애매한 메모'));
  assert.equal((await wiki.routeNext()).kind, 'held');
  assert.deepEqual(await listDir(join(root, '스터디', 'raw')), [], 'nothing queued');
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'duplicate', state: 'held', domain: 스터디 });
  assert.deepEqual(await wiki.held(), [{ id: ulid(1), domain: 스터디, text: '애매한 메모', capturedAt: '2026-10-29T08:01:00+09:00', source: 'typed', routing: { by: 'classifier', confidence: 0.3, reason: '애매함' } }]);
  assert.equal((await wiki.status()).domains.find((d) => d.domain === 스터디)!.held, 1);

  await routedTo(wiki, 2, 스터디);
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'the held memo is not picked');
  assert.equal(llm.editCalls.length, 1);
  assert.equal(git(root, 'ls-files', '--', '스터디/hold'), '', 'hold/ is never committed');

  const before = await readText(join(root, '스터디', 'hold', `${ulid(1)}.md`));
  assert.deepEqual(await wiki.confirm(ulid(1) as MemoId), { kind: 'released', domain: 스터디 });
  assert.equal(await readText(join(root, '스터디', 'raw', `${ulid(1)}.md`)), before, 'confirm keeps the file byte-identical');
  assert.deepEqual(await listDir(join(root, '스터디', 'hold')), []);
  assert.deepEqual(await wiki.held(), []);
  assert.deepEqual(await wiki.confirm(ulid(1) as MemoId), { kind: 'conflict', state: 'routed', domain: 스터디 });
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(await wiki.confirm(ulid(1) as MemoId), { kind: 'conflict', state: 'ingested', domain: 스터디 });
  assert.deepEqual(await wiki.confirm(ulid(9) as MemoId), { kind: 'not-found' });
  assert.doesNotMatch(headFile(root, '스터디/wiki/_review.md') ?? '', /라우팅 확인/, 'no review note for routing');
  await wiki.close();
});

test('a valid page commits with the ledger line, raw memo, and regenerated index', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  const r = await wiki.runNext(스터디);
  assert.equal(r.kind, 'committed');
  assert.equal(commitSubjects(root).at(-1), `ingest(스터디): ${ulid(1)}`);
  assert.deepEqual(ledgerLines(root, '스터디'), [`## [2026-10-29] ingest | ${ulid(1)} | 새 페이지 | 메모 ${ulid(1)}.md`]);
  assert.ok(headFile(root, `스터디/raw/${ulid(1)}.md`), 'raw memo committed with its job');
  assert.match(headFile(root, '스터디/wiki/index.md')!, new RegExp(`## concept\\n\\n- \\[\\[스터디/wiki/메모 ${ulid(1)}\\|메모 ${ulid(1)}\\]\\] - 요약 ${ulid(1)}`));
  assert.equal(git(root, 'status', '--porcelain', '--', '스터디'), '', 'domain is clean after the commit');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' }, 'an applied memo is not picked again');
  assert.equal(llm.editCalls.length, 1);
  await wiki.close();
});

test('page checks: required fields, allowed types, links, cross-domain links at HEAD, empty files', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 미루기);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/항목/기존 항목.md', page({ ...validFields(rawIdOf(req)), type: 'item' }));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(미루기)).kind, 'committed', 'a committed page in another domain');

  const cases: [string, (id: string) => [string, string][], string[]][] = [
    ['summary missing', (id) => [['wiki/a.md', page({ ...validFields(id), summary: '' })]], ['frontmatter']],
    ['no frontmatter', () => [['wiki/a.md', '그냥 글\n']], ['frontmatter']],
    ['type from another domain table', (id) => [['wiki/a.md', page({ ...validFields(id), type: 'item' })]], ['type']],
    ['link to a missing page', (id) => [['wiki/a.md', page(validFields(id), '[[없는 페이지]]\n')]], ['broken-link']],
    ['empty file', () => [['wiki/a.md', '']], ['empty']],
    ['page without body', (id) => [['wiki/a.md', page(validFields(id), '')]], ['empty']],
    ['edit to an existing _review.md line', () => [['wiki/_review.md', '# 바뀜\n']], ['append-only']],
  ];
  let n = 10;
  for (const [name, files, rules] of cases) {
    n++;
    await routedTo(wiki, n, 스터디);
    llm.editWith = async (req) => {
      for (const [p, c] of files(rawIdOf(req))) await modelWrites(req, p, c);
      return { kind: 'finished', verdict: 'created', pages: [] };
    };
    if (name.includes('_review.md')) await fs.writeFile(join(root, '스터디/wiki/_review.md'), '# 검토할 것\n');
    const r = await wiki.runNext(스터디);
    assert.deepEqual(problemRules(r), rules, name);
    assert.equal(await readText(join(root, '스터디/wiki/a.md')), null, `${name}: rolled back`);
    llm.editWith = async () => ({ kind: 'finished', verdict: 'unchanged', pages: [] });
    assert.equal((await wiki.runNext(스터디)).kind, 'committed', `${name}: the next attempt commits`);
  }

  await fs.mkdir(join(root, '일상/wiki/주제'), { recursive: true });
  await fs.writeFile(join(root, '일상/wiki/주제/새 주제.md'), page({ ...validFields('x'), type: 'theme' }));
  await routedTo(wiki, 51, 스터디);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/b.md', page(validFields(rawIdOf(req)), '[[미루기 아카이빙/wiki/항목/기존 항목]] [[일상/wiki/주제/새 주제]]\n'));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  const cross = await wiki.runNext(스터디);
  assert.equal(cross.kind, 'retrying');
  assert.deepEqual(cross.kind === 'retrying' && cross.problems.map((p) => p.detail), ['[[일상/wiki/주제/새 주제]] does not resolve'], 'committed page in 미루기 resolves; uncommitted page in 일상 does not');
  await wiki.close();
});

test('failed attempts feed the reason forward, give up after maxAttempts, and 재시도 reopens the job', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/a.md', page(validFields(rawIdOf(req)), '[[없음]]\n'));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'retrying');
  assert.equal((await wiki.runNext(스터디)).kind, 'retrying');
  assert.match(llm.editCalls[1]!.prompt, /지난 시도는 서버 검사에서 실패.*broken-link 스터디\/wiki\/a\.md: \[\[없음\]\] does not resolve/s, 'retry prompt carries the reason');
  assert.equal((await wiki.runNext(스터디)).kind, 'gave-up');
  assert.deepEqual(ledgerLines(root, '스터디').map((l) => l.split(' | ')[2]), ['실패 1/3', '실패 2/3', '포기 3/3']);
  assert.match(headFile(root, '스터디/wiki/_review.md')!, /ingest `01JB8ZQ4M3T9X7K2W5R6N8P001` 포기 3\/3/);
  assert.ok(headFile(root, `스터디/raw/${ulid(1)}.md`), 'gave-up memo is committed, not lost');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  assert.deepEqual((await wiki.status()).domains.find((d) => d.domain === 스터디), { domain: 스터디, agentsMayRead: true, modelProfile: null, pending: 0, held: 0, failed: 1, running: null });

  assert.deepEqual(await wiki.retry({ kind: 'ingest', domain: 스터디, id: ulid(99) }), { kind: 'not-failed' });
  assert.deepEqual(await wiki.retry({ kind: 'ingest', domain: 스터디, id: ulid(1) }), { kind: 'retrying' });
  llm.editWith = writesValidPage();
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(ledgerLines(root, '스터디').map((l) => l.split(' | ')[2]).slice(3), ['재시도', '새 페이지']);
  assert.deepEqual(await wiki.retry({ kind: 'ingest', domain: 스터디, id: ulid(1) }), { kind: 'not-failed' }, 'an applied job cannot be retried');
  await wiki.close();
});

test('index.md lists pages by the domain type order, then saved answers', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    await modelWrites(req, 'wiki/인사이트/2026.md', page({ ...validFields(id), type: 'insight', summary: '짧은 깨달음' }));
    await modelWrites(req, 'wiki/케이스/회의 안건을 질문으로 쓰기.md', page({ ...validFields(id), type: 'case', summary: '안건을 질문으로' }));
    await modelWrites(req, 'wiki/RAG.md', page({ ...validFields(id), summary: '청크 크기' }, '[[회의 안건을 질문으로 쓰기]] [[인사이트/2026]]\n'));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  const filed = await wiki.fileAnswer({
    id: ulid(2) as never, domain: 스터디, question: '내가 RAG에 대해 알아낸 게 뭐였지?', answer: '청크 512.', cited: [{ domain: 스터디, page: 'RAG' }],
    sessionId: 's1', askedAt: '2026-10-29T09:00:00.000Z',
  });
  assert.deepEqual(filed, { kind: 'created' });
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.equal(headFile(root, '스터디/wiki/index.md'), [
    '# 스터디 색인', '', '서버가 페이지 frontmatter에서 만든다. 고치지 않는다.', '',
    '## concept', '', '- [[스터디/wiki/RAG|RAG]] - 청크 크기', '',
    '## case', '', '- [[스터디/wiki/케이스/회의 안건을 질문으로 쓰기|케이스/회의 안건을 질문으로 쓰기]] - 안건을 질문으로', '',
    '## insight', '', '- [[스터디/wiki/인사이트/2026|인사이트/2026]] - 짧은 깨달음', '',
    '## 저장된 답', '', '- [[스터디/wiki/answers/2026-10-29 내가 RAG에 대해 알아낸 게 뭐였지|answers/2026-10-29 내가 RAG에 대해 알아낸 게 뭐였지]] - 내가 RAG에 대해 알아낸 게 뭐였지?', '',
  ].join('\n'));
  await wiki.close();
});

test('answers: cited pages must exist at HEAD; the filed page lands in wiki/answers once', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  const filing = { id: ulid(7) as never, domain: 스터디, question: '질문?', answer: '답.', cited: [{ domain: 스터디, page: 'RAG' }], sessionId: null, askedAt: '2026-10-29T09:00:00.000Z' };
  assert.deepEqual(await wiki.fileAnswer(filing), { kind: 'rejected', reason: 'cited page 스터디/wiki/RAG does not exist' });
  const uncited = { ...filing, cited: [] };
  assert.deepEqual(await wiki.fileAnswer(uncited), { kind: 'created' });
  assert.deepEqual(await wiki.fileAnswer(uncited), { kind: 'duplicate' });
  assert.equal((await wiki.runNext(스터디, { withLlm: false })).kind, 'committed', 'file-answer needs no LLM');
  assert.deepEqual(await wiki.fileAnswer(uncited), { kind: 'duplicate' }, 'after commit, resend is still a duplicate');
  assert.deepEqual(git(root, 'ls-tree', '--name-only', 'HEAD', '스터디/wiki/answers/').trim().split('\n'), ['스터디/wiki/answers/.gitkeep', '스터디/wiki/answers/2026-10-29 질문.md']);
  const text = headFile(root, '스터디/wiki/answers/2026-10-29 질문.md')!;
  for (const field of ['type: answer', 'derived: true', 'question: 질문?', 'session_id: null', 'asked_at: 2026-10-29T09:00:00.000Z', 'summary: 질문?', 'status: active']) {
    assert.ok(text.includes(field), `answer frontmatter has ${field}`);
  }
  assert.deepEqual(await listDir(join(root, 'inbox', 'answers', '스터디')), [], 'staging file removed after commit');
  await wiki.close();
});

test('confinement: a write attempt outside <d>/wiki fails the attempt and leaves no file outside', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/ok.md', page(validFields(rawIdOf(req))));
    req.onTouch('../escape.md');
    await modelWrites(req, 'notes.md', 'escaped\n');
    await fs.writeFile(join(req.cwd, 'wiki', 'unreported.md'), page(validFields(rawIdOf(req))));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  const r = await wiki.runNext(스터디);
  assert.equal(r.kind, 'retrying');
  assert.deepEqual(r.kind === 'retrying' && r.problems.map((p) => [p.rule, p.path]), [['scope', 'escape.md'], ['scope', '스터디/notes.md']]);
  assert.equal(await readText(join(root, '스터디', 'notes.md')), null, 'in-domain escape removed by rollback');
  assert.equal(await readText(join(root, 'escape.md')), null, 'nothing at the root');
  assert.equal(await readText(join(root, '스터디', 'wiki', 'ok.md')), null, 'in-scope write of the failed attempt rolled back too');
  assert.equal(await readText(join(root, '스터디', 'wiki', 'unreported.md')), null, 'a file created under wiki/ without a tool event is rolled back');
  assert.equal(llm.editCalls[0]!.writableDir, 'wiki', 'the port is told the one writable directory');
  await wiki.close();
});

test('a human edit made while no job runs is committed as manual(<d>) before the next job', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  await routedTo(wiki, 1, 스터디);
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  await fs.appendFile(join(root, '스터디', 'wiki', `메모 ${ulid(1)}.md`), '사람이 덧붙임\n');
  await routedTo(wiki, 2, 스터디);
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(commitSubjects(root).slice(-3), [`ingest(스터디): ${ulid(1)}`, 'manual(스터디)', `ingest(스터디): ${ulid(2)}`]);
  assert.match(headFile(root, `스터디/wiki/메모 ${ulid(1)}.md`)!, /사람이 덧붙임/);
  await wiki.close();
});

test('a raw/ memo still being written by the router is left out of the manual commit', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  await routedTo(wiki, 1, 스터디);
  const inFlight = join(root, '스터디', 'raw', `.tmp-${ulid(2)}.md-0123456789ab`);
  await fs.writeFile(inFlight, 'half');
  await fs.writeFile(join(root, '스터디', 'wiki', '사람.md'), page(validFields('x')));
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.ok(headFile(root, '스터디/wiki/사람.md'), 'the human edit is committed');
  assert.equal(git(root, 'ls-files', '--', '스터디/raw/.tmp-*'), '', 'the router tmp file is not');
  await wiki.close();
});

test('a root reached through a symlink still confines by real path, as claude reports it', async () => {
  const real = await tempWiki();
  const link = `${real}-link`;
  await fs.symlink(real, link);
  const llm = fakeLlm();
  llm.editWith = async (req) => {
    const id = rawIdOf(req);
    const abs = join(await fs.realpath(req.cwd), 'wiki', `메모 ${id}.md`);
    req.onTouch(abs);
    await fs.writeFile(abs, page(validFields(id)));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  const wiki = await open(link, llm);
  await routedTo(wiki, 1, 스터디);
  const r = await wiki.runNext(스터디);
  assert.equal(r.kind, 'committed', JSON.stringify(problemRules(r)));
  await wiki.close();
});

const failsCheck = async (req: EditRequest): Promise<EditResult> => {
  await modelWrites(req, 'wiki/a.md', page(validFields(rawIdOf(req)), '[[없음]]\n'));
  return { kind: 'finished', verdict: 'created', pages: [] };
};

const TYPE_OF: Record<string, string> = { 스터디: 'concept', '미루기 아카이빙': 'item', 일상: 'me' };
const writesPageOfDomainType = async (req: EditRequest): Promise<EditResult> => {
  const id = rawIdOf(req);
  await modelWrites(req, `wiki/메모 ${id}.md`, page(validFields(id, { type: TYPE_OF[basename(req.cwd)] })));
  return { kind: 'finished', verdict: 'created', pages: [] };
};

async function giveUp(wiki: Wiki, llm: ReturnType<typeof fakeLlm>, d: DomainName) {
  llm.editWith = failsCheck;
  for (const kind of ['retrying', 'retrying', 'gave-up']) assert.equal((await wiki.runNext(d)).kind, kind);
  llm.editWith = writesPageOfDomainType;
}

test('move: a held memo is queued in the chosen domain with user routing; conflicts name the state', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  llm.editWith = writesPageOfDomainType;
  const wiki = await open(root, llm);
  llm.classifyWith = async () => ({ kind: 'classified', domain: '스터디', confidence: 0.3, reason: '애매함' });
  await wiki.accept(memo(1, '나중에 볼 영상'));
  assert.equal((await wiki.routeNext()).kind, 'held');

  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 스터디), { kind: 'conflict', state: 'held', domain: 스터디 }, 'already there');
  assert.deepEqual(await wiki.move(ulid(9) as MemoId, 미루기), { kind: 'not-found' });
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 미루기), { kind: 'released', domain: 미루기 });
  assert.deepEqual(await listDir(join(root, '스터디', 'hold')), []);
  const moved = (await readText(join(root, '미루기 아카이빙', 'raw', `${ulid(1)}.md`)))!;
  assert.match(moved, /routing:\n {2}by: user\n {2}from: 스터디\n {2}previous:\n {4}by: classifier\n {4}confidence: 0.3\n {4}reason: 애매함\n/);
  assert.match(moved, /\n나중에 볼 영상\n$/, 'body kept');
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 일상), { kind: 'conflict', state: 'routed', domain: 미루기 });

  await fs.mkdir(join(root, '.gateway', 'inflight'), { recursive: true });
  await fs.writeFile(join(root, '.gateway', 'inflight', '미루기 아카이빙.json'), JSON.stringify({ job: { kind: 'ingest', domain: 미루기, id: ulid(1) }, base: 'x', attempt: 1, since: 'x', inputs: {} }));
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 일상), { kind: 'conflict', state: 'running', domain: 미루기 });
  await fs.rm(join(root, '.gateway', 'inflight', '미루기 아카이빙.json'));

  assert.equal((await wiki.runNext(미루기)).kind, 'committed');
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 일상), { kind: 'conflict', state: 'ingested', domain: 미루기 });
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  await wiki.close();
});

test('move: a gave-up memo leaves its domain in one commit and is ingested in the new one, sidecar reused', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const fetch = fakeFetch();
  const wiki = await open(root, llm, { fetchSource: fetch });
  await routedTo(wiki, 1, 스터디, '읽어볼 글 https://example.com/post');
  await giveUp(wiki, llm, 스터디);
  const sidecar = headFile(root, `스터디/raw/${ulid(1)}.source.md`);
  assert.ok(sidecar, 'the gave-up sidecar is tracked');
  assert.deepEqual(await wiki.confirm(ulid(1) as MemoId), { kind: 'conflict', state: 'failed', domain: 스터디 }, 'gave-up is not confirmable');

  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 미루기), { kind: 'released', domain: 미루기 });
  assert.equal(commitSubjects(root).at(-1), `move(스터디→미루기 아카이빙): ${ulid(1)}`);
  assert.equal(ledgerLines(root, '스터디').at(-1), `## [2026-10-29] ingest | ${ulid(1)} | 이동 → 미루기 아카이빙 | -`);
  assert.equal(headFile(root, `스터디/raw/${ulid(1)}.md`), null);
  assert.equal(headFile(root, `스터디/raw/${ulid(1)}.source.md`), null);
  assert.equal(git(root, 'status', '--porcelain', '--', '스터디'), '', 'source domain clean');
  assert.equal(await readText(join(root, '미루기 아카이빙', 'raw', `${ulid(1)}.source.md`)), sidecar, 'same sidecar bytes');
  assert.equal((await wiki.status()).domains.find((d) => d.domain === 스터디)!.failed, 0);
  assert.deepEqual(await wiki.retry({ kind: 'ingest', domain: 스터디, id: ulid(1) }), { kind: 'not-failed' });
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'duplicate', state: 'routed', domain: 미루기 });

  const r = await wiki.runNext(미루기);
  assert.equal(r.kind, 'committed', JSON.stringify(r));
  assert.deepEqual(fetch.calls, ['https://example.com/post'], 'enrichment skipped in the new domain');
  assert.match(llm.editCalls.at(-1)!.prompt, /source\.md/, 'the moved sidecar is a job input');
  assert.deepEqual(await wiki.runNext(스터디), { kind: 'idle' });
  await wiki.close();
});

test('move: a memo moved back into a domain it gave up in is reopened there', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  await giveUp(wiki, llm, 스터디);
  assert.equal((await wiki.move(ulid(1) as MemoId, 미루기)).kind, 'released');
  await giveUp(wiki, llm, 미루기);
  assert.deepEqual(await wiki.move(ulid(1) as MemoId, 스터디), { kind: 'released', domain: 스터디 });
  assert.deepEqual(ledgerLines(root, '스터디').map((l) => l.split(' | ')[2]), ['실패 1/3', '실패 2/3', '포기 3/3', '이동 → 미루기 아카이빙', '재시도']);
  assert.equal((await wiki.runNext(스터디)).kind, 'committed');
  assert.deepEqual(ledgerLines(root, '미루기 아카이빙').map((l) => l.split(' | ')[2]).at(-1), '이동 → 스터디');
  assert.deepEqual((await wiki.status()).domains.map((d) => d.failed), [0, 0, 0]);
  await wiki.close();
});

test('wikilink syntax quoted in code is not checked as a link', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await routedTo(wiki, 1, 스터디);
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/a.md', page(validFields(rawIdOf(req)), 'YAML 중첩 배열 `[[...]]` 와 ``[[없는 페이지]]``\n\n```\n[[코드 블록 안]]\n```\n'));
    return { kind: 'finished', verdict: 'created', pages: [] };
  };
  assert.equal((await wiki.runNext(스터디)).kind, 'committed', 'code spans and fences hold no links');
  await wiki.close();
});

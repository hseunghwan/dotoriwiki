import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttp } from '../src/http.ts';
import { parseModels, profileNames, routeLlm } from '../src/models.ts';
import { parseWikiConfig, WikiConfigError, type ConfigParse, type DomainName, type WikiOptions } from '../src/wiki/index.ts';
import { commitSubjects, editConfig, fakeLlm, headFile, memo, open, readText, tempWiki, ulid } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const en = readFileSync(join(FIX, 'wiki-en', 'dotoriwiki.yaml'), 'utf8');
const ko = readFileSync(join(FIX, 'wiki', 'dotoriwiki.yaml'), 'utf8');
const machine = { modelProfiles: new Set(['default', 'strong']) };
const keys = (r: ConfigParse) => (r.ok ? [] : r.problems.map((p) => p.key));

test('the English fixture parses in written order with its page types', () => {
  const r = parseWikiConfig(en, machine);
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, []);
  const c = r.config;
  assert.equal(c.locale, 'en');
  assert.equal(c.timeZone, 'America/Chicago');
  assert.equal(c.fallbackDomain, 'journal');
  assert.deepEqual([...c.domains.keys()], ['journal', 'learning', 'someday']);
  assert.deepEqual(c.domains.get('learning' as never)!.pageTypes.map((t) => t.type), ['concept', 'case', 'project']);
  assert.deepEqual(c.domains.get('journal' as never)!.pageTypes[1], { type: 'person', description: 'One person. What they like, what we did, what they told me', example: 'people/Sam.md' });
  assert.equal(c.domains.get('learning' as never)!.agentsMayRead, true);
  assert.equal(c.domains.get('journal' as never)!.agentsMayRead, false);
  assert.equal(c.feeds.size, 0);
});

test('the Korean fixture parses, and an NFD domain key is read as NFC', () => {
  for (const text of [ko, ko.replace('미루기 아카이빙:', '미루기 아카이빙:'.normalize('NFD'))]) {
    const r = parseWikiConfig(text, machine);
    assert.ok(r.ok);
    assert.deepEqual([...r.config.domains.keys()], ['일상', '스터디', '미루기 아카이빙']);
    assert.equal(r.config.fallbackDomain, '일상');
    assert.equal(r.config.timeZone, 'Asia/Seoul');
  }
});

test('an integer-like domain key keeps its written place', () => {
  const r = parseWikiConfig(en.replace('  someday:\n', '  2026:\n'), machine);
  assert.ok(r.ok);
  assert.deepEqual([...r.config.domains.keys()], ['journal', 'learning', '2026']);
});

test('feeds name a declared domain; model_profile resolves against the machine or warns and falls back', () => {
  const text = `${en.replace('    agents_may_read: true\n', '    agents_may_read: true\n    model_profile: strong\n').replace('  someday:\n    description', '  someday:\n    model_profile: huge\n    description')}\nfeeds:\n  hackernews: { domain: learning }\n`;
  const r = parseWikiConfig(text, machine);
  assert.ok(r.ok);
  assert.deepEqual([...r.config.feeds], [['hackernews', { domain: 'learning' }]]);
  assert.equal(r.config.domains.get('learning' as never)!.modelProfile, 'strong');
  assert.equal(r.config.domains.get('someday' as never)!.modelProfile, null);
  assert.deepEqual(r.warnings.map((w) => w.key), ['domains.someday.model_profile']);
  assert.match(r.warnings[0]!.problem, /huge is not in this machine's models\.json, so someday runs on edit\.default/);
});

test('each broken variant reports every one of its problems, each with a key and a fix', () => {
  const cases: [string, string, string[]][] = [
    ['misspelled key', en.replace('fallback_domain:', 'fallback_domian:'), ['fallback_domian', 'fallback_domain']],
    ['fallback not a domain', en.replace('fallback_domain: journal', 'fallback_domain: 일상'), ['fallback_domain']],
    ['newer version', en.replace('version: 1', 'version: 2'), ['version']],
    ['missing version, bad locale and zone', en.replace('version: 1\n', '').replace('locale: en', 'locale: fr').replace('America/Chicago', 'Mars/Base'), ['version', 'locale', 'time_zone']],
    ['answer declared, reserved name, bad character', en.replace('      me:\n', '      answer:\n').replace('  someday:\n', '  root:\n').replace('  learning:\n', '  learn#ing:\n'), ['domains.journal.page_types.answer', 'domains.learn#ing', 'domains.root']],
    ['domain without page types or description', `${en.replace('domains:\n', 'domains:\n  recipes: {}\n')}`, ['domains.recipes.description', 'domains.recipes.page_types']],
    ['feed to a missing domain and an unknown feed', `${en}feeds:\n  hackernews: { domain: news }\n  reddit: { domain: learning }\n`, ['feeds.hackernews.domain', 'feeds.reddit']],
    ['bad example path and agents flag', en.replace('example: RAG.md', 'example: ../RAG.md').replace('    agents_may_read: true', '    agents_may_read: yes please'), ['domains.learning.agents_may_read', 'domains.learning.page_types.concept.example']],
    ['no domains', 'version: 1\nlocale: en\ntime_zone: UTC\nfallback_domain: journal\ndomains: {}\n', ['domains', 'fallback_domain']],
    ['YAML syntax', 'version: 1\nlocale: [en\n', ['dotoriwiki.yaml']],
    ['duplicate key', en.replace('locale: en', 'locale: en\nlocale: ko'), ['dotoriwiki.yaml']],
    ['not a mapping', '- a\n- b\n', ['dotoriwiki.yaml']],
  ];
  for (const [name, text, expected] of cases) {
    const r = parseWikiConfig(text, machine);
    assert.deepEqual(keys(r).sort(), [...expected].sort(), name);
    assert.ok(!r.ok && r.problems.every((p) => p.problem && p.fix), `${name}: each problem says what and how to fix`);
  }
});

test('a domain that fails its own checks does not also fail the keys that name it', () => {
  const r = parseWikiConfig(en.replace('    description: My days, the people in them, and what I make of it all\n', ''), machine);
  assert.deepEqual(keys(r), ['domains.journal.description']);
});

const TOKEN = 'test-token-0123456789';

async function serve(root: string, llm = fakeLlm(), extra: Partial<WikiOptions> = {}) {
  const wiki = await open(root, llm, extra);
  const http = await startHttp({ wiki, chat: async function* () {}, token: TOKEN, serverVersion: '0.1.0', now: () => new Date('2026-10-29T00:00:00Z'), maxBodyBytes: 4096 }, { host: '127.0.0.1', port: 0 });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${http.port}${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { wiki, call, close: async () => (await http.close(), await wiki.close()) };
}

const memoBody = (n: number, text: string) => ({ id: ulid(n), text, captured_at: '2026-10-29T08:10:00-05:00', tz: 'America/Chicago', source: 'typed' });

test('a wiki with English domain names and no 일상 folder opens, routes, and ingests a memo', async () => {
  const root = await tempWiki('en');
  assert.equal(await readText(join(root, '일상', 'CLAUDE.md')), null);
  const llm = fakeLlm();
  llm.classifyWith = async () => ({ kind: 'classified', domain: 'learning', confidence: 0.9, reason: 'fake' });
  const wiki = await open(root, llm);
  assert.deepEqual(commitSubjects(root), ['manual(config)', 'init(journal)', 'init(learning)', 'init(someday)']);
  await wiki.accept(memo(1, 'Chunk size 512 made retrieval better'));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  const run = await wiki.runNext('learning' as DomainName);
  assert.equal(run.kind, 'committed');
  assert.deepEqual(llm.classifyCalls[0]!.domains, ['journal', 'learning', 'someday']);
  assert.match(llm.classifyCalls[0]!.systemPrompt, /# My wiki[\s\S]*\| `learning` \| What I learned by doing it myself, at work or on my own \|/);
  assert.match(llm.editCalls[0]!.systemPrompt, /# Rules for every domain[\s\S]*\| `concept` \| `RAG.md` \| One idea\./, 'the domain prompt imports the rules and gets the page types');
  assert.match(headFile(root, 'learning/wiki/log.md')!, /^## \[2026-10-28\] ingest \| 01JB8ZQ4M3T9X7K2W5R6N8P001 \| /m, 'the ledger date is in the wiki time zone');
  assert.match(headFile(root, 'learning/wiki/index.md')!, /^# learning/);

  llm.classifyWith = async () => ({ kind: 'no-answer', detail: 'none' });
  await wiki.accept(memo(2));
  assert.deepEqual(await wiki.routeNext(), { kind: 'held', id: ulid(2), domain: 'journal', routing: { by: 'fallback', reason: 'none' } });
  await wiki.close();
});

test('a broken dotoriwiki.yaml at startup opens paused: /status lists each problem, and a memo still lands in inbox/', async () => {
  const root = await tempWiki('en');
  const good = await fs.readFile(join(root, 'dotoriwiki.yaml'), 'utf8');
  await fs.writeFile(join(root, 'dotoriwiki.yaml'), good.replace('fallback_domain: journal', 'fallback_domain: 일상'));
  const s = await serve(root);
  assert.equal(headFile(root, 'dotoriwiki.yaml'), null, 'nothing is committed while paused');
  const status = await s.call('GET', '/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.domains, {});
  assert.deepEqual(status.body.config, {
    state: 'paused',
    problems: [{ key: 'fallback_domain', problem: 'is "일상", which is not one of the domains (journal, learning, someday)', fix: 'name a key under `domains`' }],
  });
  assert.equal((await s.call('POST', '/memos', memoBody(1, 'Sam loves salt bread'))).status, 201);
  assert.ok(await readText(join(root, 'inbox', `${ulid(1)}.md`)), 'the memo waits in the inbox');
  assert.deepEqual(await s.wiki.routeNext(), { kind: 'paused', problems: (status.body.config as { problems: unknown }).problems });
  assert.deepEqual(await s.wiki.runNext('journal' as DomainName), { kind: 'paused' });
  const held = await s.call('GET', '/held');
  assert.equal(held.status, 503);
  assert.equal(held.body.error, 'paused');
  assert.match(String(held.body.detail), /fallback_domain: is "일상"/);

  await fs.writeFile(join(root, 'dotoriwiki.yaml'), good);
  assert.equal(((await s.call('GET', '/status')).body.config as { state: string }).state, 'ok');
  const routed = await s.wiki.routeNext();
  assert.equal(routed.kind, 'held', 'the fixed file resumes routing');
  assert.equal((await s.wiki.runNext('journal' as DomainName)).kind, 'idle');
  assert.ok(commitSubjects(root).includes('init(journal)'), 'a domain first seen after open gets its init commit on its first run');
  await s.close();
});

test('breaking the file while running pauses, and fixing it resumes, without losing a memo', async () => {
  const root = await tempWiki('en');
  const llm = fakeLlm();
  llm.classifyWith = async () => ({ kind: 'classified', domain: 'learning', confidence: 0.9, reason: 'fake' });
  const wiki = await open(root, llm);
  const good = await fs.readFile(join(root, 'dotoriwiki.yaml'), 'utf8');
  await fs.writeFile(join(root, 'dotoriwiki.yaml'), good.replace('time_zone: America/Chicago', 'time_zon: America/Chicago'));
  assert.deepEqual(await wiki.accept(memo(1)), { kind: 'created' });
  const paused = await wiki.routeNext();
  assert.deepEqual(paused.kind === 'paused' ? paused.problems.map((p) => p.key).sort() : paused, ['time_zon', 'time_zone']);
  await assert.rejects(wiki.config(), WikiConfigError);
  await assert.rejects(wiki.memos({ limit: 10, before: null }), /time_zon: is not a known key/);
  assert.equal((await wiki.status()).paused, true);

  await fs.writeFile(join(root, 'dotoriwiki.yaml'), good);
  assert.equal((await wiki.routeNext()).kind, 'routed');
  assert.equal((await wiki.runNext('learning' as DomainName)).kind, 'committed');
  await wiki.close();
});

test('an unknown model profile runs the domain on edit.default and shows in /status', async () => {
  const root = await tempWiki('en');
  await editConfig(root, (c) => {
    const domains = c.domains as Record<string, Record<string, unknown>>;
    return { ...c, domains: { ...domains, learning: { ...domains.learning, model_profile: 'strong' }, someday: { ...domains.someday, model_profile: 'huge' } } };
  });
  const served: string[] = [];
  const llm = fakeLlm();
  const models = parseModels({ edit: { default: { provider: 'claude', model: 'sonnet' }, strong: { provider: 'claude', model: 'opus' } } });
  const routed = routeLlm(models, (c) => ({ classify: llm.classify, edit: (req) => (served.push(`${req.modelProfile} → ${c.model}`), llm.edit(req)) }));
  const s = await serve(root, llm, { llm: routed, modelProfiles: profileNames(models) });
  const status = await s.call('GET', '/status');
  assert.deepEqual(status.body.config, {
    state: 'ok',
    problems: [{ key: 'domains.someday.model_profile', problem: "huge is not in this machine's models.json, so someday runs on edit.default", fix: 'add edit.huge to models.json, or remove model_profile' }],
  });
  const domains = status.body.domains as Record<string, { model_profile: string | null; agents_may_read: boolean }>;
  assert.deepEqual([domains.learning, domains.someday].map((d) => [d!.model_profile, d!.agents_may_read]), [['strong', true], [null, false]]);
  for (const [n, domain] of [[1, 'learning'], [2, 'someday']] as const) {
    await s.wiki.accept(memo(n, `memo ${n}`, { domain_hint: domain }));
    await s.wiki.routeNext();
    await s.wiki.runNext(domain as DomainName);
  }
  assert.deepEqual(served, ['strong → opus', 'null → sonnet']);
  await s.close();
});

test('a hand edit of dotoriwiki.yaml is committed before the next job, and a domain added at runtime is routed to', async () => {
  const root = await tempWiki('en');
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await fs.mkdir(join(root, 'recipes'));
  await fs.writeFile(join(root, 'recipes', 'CLAUDE.md'), '# recipes\n\nDishes I cooked.\n');
  await editConfig(root, (c) => ({ ...c, domains: { ...(c.domains as object), recipes: { description: 'Dishes I cooked', page_types: { concept: { description: 'One dish' } } } } }));
  llm.classifyWith = async () => ({ kind: 'classified', domain: 'recipes', confidence: 0.9, reason: 'fake' });
  await wiki.accept(memo(1, 'Kimchi stew: more anchovy stock'));
  assert.equal((await wiki.routeNext()).kind, 'routed');
  assert.equal((await wiki.runNext('recipes' as DomainName)).kind, 'committed');
  assert.deepEqual(commitSubjects(root).slice(4), ['init(recipes)', 'manual(config)', `ingest(recipes): ${ulid(1)}`]);
  assert.match(headFile(root, 'dotoriwiki.yaml')!, /recipes:/);
  await wiki.close();
});

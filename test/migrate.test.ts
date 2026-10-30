import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configText, migrate, readLegacy, type MigrateFlags } from '../scripts/migrate-config.ts';
import { parseWikiConfig } from '../src/wiki/index.ts';
import { commitSubjects, fakeLlm, git, open, readText, tempWiki } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const CLAUDE_FILES = ['CLAUDE.md', '일상/CLAUDE.md', '스터디/CLAUDE.md', '미루기 아카이빙/CLAUDE.md'];
const flags: MigrateFlags = { fallback: '일상', feedsTo: null, timeZone: 'Asia/Seoul', locale: 'ko', models: null };

/** The fixture as it was before dotoriwiki.yaml: the legacy tables in its CLAUDE.md files, committed. */
async function legacyWiki(): Promise<string> {
  const root = await tempWiki();
  await fs.rm(join(root, 'dotoriwiki.yaml'));
  for (const f of CLAUDE_FILES) await fs.copyFile(join(FIX, 'legacy-wiki', f), join(root, f));
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'legacy');
  return root;
}

test('migrating the legacy fixture yields exactly the current fixture, in one commit, once', async () => {
  const root = await legacyWiki();
  assert.equal(await migrate(root, flags), 'migrated');
  for (const f of ['dotoriwiki.yaml', ...CLAUDE_FILES]) assert.equal(await readText(join(root, f)), await readText(join(FIX, 'wiki', f)), f);
  assert.deepEqual(commitSubjects(root), ['legacy', 'config: move the domain and page-type tables into dotoriwiki.yaml']);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(await migrate(root, flags), 'already-migrated');
  assert.equal(commitSubjects(root).length, 2);
  const wiki = await open(root, fakeLlm());
  assert.deepEqual([...(await wiki.config()).domains.keys()], ['일상', '스터디', '미루기 아카이빙']);
  await wiki.close();
});

test('a models.json edit key naming a domain becomes its model_profile, and --feeds-to routes every feed', async () => {
  const legacy = readLegacy(await fs.readFile(join(FIX, 'legacy-wiki', 'CLAUDE.md'), 'utf8'), (d) => readFileSync(join(FIX, 'legacy-wiki', d, 'CLAUDE.md'), 'utf8'));
  const models = { edit: { default: { provider: 'claude', model: 'sonnet' }, 스터디: { provider: 'codex', model: 'gpt-6.1-terra' } } };
  const text = configText(legacy, { ...flags, feedsTo: '스터디', models });
  const r = parseWikiConfig(text, { modelProfiles: new Set(['default', '스터디']) });
  assert.ok(r.ok);
  assert.equal(r.config.domains.get('스터디' as never)!.modelProfile, '스터디');
  assert.equal(r.config.domains.get('일상' as never)!.modelProfile, null);
  assert.deepEqual([...r.config.feeds].map(([f, { domain }]) => `${f}→${domain}`), ['geeknews→스터디', 'hackernews→스터디', 'ghsa→스터디']);
});

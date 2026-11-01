import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { BILLING, doctor, type Check } from '../src/doctor.ts';
import { initWiki } from '../src/init.ts';
import { parseEnvFile } from '../src/machine.ts';
import { parseWikiConfig, type DomainName } from '../src/wiki/index.ts';
import { commitSubjects, editConfig, fakeLlm, git, ledgerLines, memo, open } from './helpers.ts';

const execFileP = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

/** A temp HOME with a stand-in claude, so neither init nor doctor touches the real ~/.config or calls a model. */
async function machine(): Promise<{ dir: string; env: NodeJS.ProcessEnv; envFile: string }> {
  const dir = await fs.mkdtemp(join(process.env.DOTORIWIKI_TEST_TMP ?? tmpdir(), 'dotoriwiki-cli-'));
  const claude = join(dir, 'claude');
  await fs.writeFile(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), CLAUDE_BIN: claude, LANG: 'C' };
  return { dir, env, envFile: join(dir, 'home', '.config', 'dotoriwiki', 'gateway.env') };
}

const fails = (checks: readonly Check[]) => checks.filter((c) => c.status === 'fail').map((c) => c.what);

for (const locale of ['en', 'ko'] as const) {
  test(`init ${locale}: doctor passes, and the gateway routes, ingests, and commits a memo`, async () => {
    const { dir, env, envFile } = await machine();
    const root = join(dir, 'wiki');
    const r = await initWiki(root, locale, env);
    assert.deepEqual(r.added, ['WIKI_ROOT', 'PORT', 'HOST', 'GATEWAY_TOKEN']);
    assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);
    const vars = parseEnvFile(await fs.readFile(envFile, 'utf8'));
    assert.equal(vars.get('WIKI_ROOT'), root);
    assert.match(vars.get('GATEWAY_TOKEN')!, /^[0-9a-f]{48}$/);

    const config = parseWikiConfig(await fs.readFile(join(root, 'dotoriwiki.yaml'), 'utf8'), { modelProfiles: new Set() });
    assert.ok(config.ok);
    assert.equal(config.config.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'time zone from this machine');
    assert.equal(config.config.locale, locale);
    assert.equal(git(root, 'status', '--porcelain', '--', '.', ...[...config.config.domains.keys()].map((d) => `:!${d}`)), '', 'everything but the domains is in the init commit');

    const before = git(root, 'status', '--porcelain', '--ignored', '--untracked-files=all');
    const checks = await doctor(env);
    assert.deepEqual(fails(checks), []);
    assert.ok(checks.some((c) => c.status === 'info' && c.what === 'no gateway is running on this wiki'));
    assert.equal(git(root, 'status', '--porcelain', '--ignored', '--untracked-files=all'), before, 'doctor wrote nothing');
    assert.deepEqual(commitSubjects(root), ['init']);

    const domains = [...config.config.domains.keys()];
    const target = domains[1]!;
    const llm = fakeLlm();
    llm.classifyWith = async () => ({ kind: 'classified', domain: target, confidence: 0.9, reason: 'fake' });
    const wiki = await open(root, llm);
    const running = await doctor(env);
    assert.ok(running.some((c) => c.status === 'info' && c.what === `a gateway is running on this wiki (pid ${process.pid})`));
    assert.deepEqual(fails(running), []);
    await wiki.accept(memo(1));
    assert.equal((await wiki.routeNext()).kind, 'routed');
    assert.equal((await wiki.runNext(target as DomainName)).kind, 'committed');
    await wiki.close();
    assert.deepEqual(commitSubjects(root).slice(0, domains.length + 1), ['init', ...domains.map((d) => `init(${d})`)]);
    assert.match(commitSubjects(root).at(-1)!, /^ingest\(/);
    assert.equal(ledgerLines(root, target).length, 1);
  });
}

test('doctor names the failing key of a broken dotoriwiki.yaml and a domain without CLAUDE.md', async () => {
  const { dir, env } = await machine();
  const root = join(dir, 'wiki');
  await initWiki(root, 'en', env);
  await editConfig(root, (c) => {
    const domains = c.domains as Record<string, Record<string, unknown>>;
    delete domains.learning!.description;
    return c;
  });
  await fs.rm(join(root, 'journal', 'CLAUDE.md'));
  let failed = fails(await doctor(env));
  assert.equal(failed.length, 1);
  assert.match(failed[0]!, /^dotoriwiki\.yaml domains\.learning\.description: is missing/);

  git(root, 'checkout', '--', 'dotoriwiki.yaml');
  failed = fails(await doctor(env));
  assert.deepEqual(failed, ['dotoriwiki.yaml domains.journal: journal/CLAUDE.md does not exist']);
});

test('doctor fails on a missing env file and names it, and says how to move one from before the rename', async () => {
  const { dir, env, envFile } = await machine();
  const checks = await doctor(env);
  assert.deepEqual(fails(checks), [`the env file ${envFile} does not exist`]);
  assert.deepEqual(checks.filter((c) => c.status === 'warn'), []);

  const old = join(dir, 'home', '.config', 'llmwiki');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(join(old, 'gateway.env'), 'PORT=8787\n');
  const warned = (await doctor(env)).filter((c) => c.status === 'warn');
  assert.deepEqual(warned.map((c) => c.what), [`${old} holds an env file from before the rename to dotoriwiki`]);
  assert.match(warned[0]!.fix!, new RegExp(`mv ${old}/\\* ${join(dir, 'home', '.config', 'dotoriwiki')}/`));
});

test('doctor shows who claude bills, fails api billing without a key, and never prints the key', async () => {
  const { dir, env, envFile } = await machine();
  await initWiki(join(dir, 'wiki'), 'en', env);
  const secret = 'sk-ant-api03-doctor-test-secret';
  const run = async (extra: NodeJS.ProcessEnv = {}) => {
    const checks = await doctor({ ...env, ...extra });
    assert.ok(!checks.some((c) => `${c.what} ${c.fix}`.includes(secret)), 'the key is never printed');
    return { failed: fails(checks), billing: checks.filter((c) => c.what.startsWith('claude bills')) };
  };

  assert.deepEqual(await run({ ANTHROPIC_API_KEY: secret }), { failed: [], billing: [{ status: 'info', what: BILLING.subscription, fix: null }] });

  await fs.appendFile(envFile, 'CLAUDE_BILLING=api\n');
  const missing = await run();
  assert.equal(missing.failed.length, 1);
  assert.match(missing.failed[0]!, new RegExp(`^${envFile}: CLAUDE_BILLING=api needs ANTHROPIC_API_KEY\\. Add it to the env file`));

  await fs.appendFile(envFile, `ANTHROPIC_API_KEY=${secret}\n`);
  assert.deepEqual(await run(), { failed: [], billing: [{ status: 'info', what: BILLING.api, fix: null }] });
});

test('init refuses a folder that is not empty, and keeps the keys an env file already sets', async () => {
  const { dir, env, envFile } = await machine();
  const taken = join(dir, 'taken');
  await fs.mkdir(taken);
  await fs.writeFile(join(taken, 'notes.md'), 'mine\n');
  await assert.rejects(initWiki(taken, 'en', env), /is not empty/);
  assert.deepEqual(await fs.readdir(taken), ['notes.md']);

  await fs.mkdir(join(dir, 'home', '.config', 'dotoriwiki'), { recursive: true });
  await fs.writeFile(envFile, '# mine\nGATEWAY_TOKEN=keep-this-token-0123456789\nPORT=9999\nWIKI_ROOT=/elsewhere/wiki', { mode: 0o644 });
  const r = await initWiki(join(dir, 'wiki'), 'ko', env);
  assert.deepEqual(r.added, ['HOST']);
  assert.equal(r.otherWikiRoot, '/elsewhere/wiki');
  assert.equal(await fs.readFile(envFile, 'utf8'), '# mine\nGATEWAY_TOKEN=keep-this-token-0123456789\nPORT=9999\nWIKI_ROOT=/elsewhere/wiki\nHOST=127.0.0.1\n');
  assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);
});

test('the command line: init picks the locale from LANG and quotes a path with a space, doctor exits 0 on the new wiki and 1 without one', async () => {
  const { dir, env } = await machine();
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => execFileP(process.execPath, [cli, ...args], { env: { ...env, ...extra } }).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
  );
  assert.equal((await run(['doctor'])).code, 1);
  const init = await run(['init', 'my wiki'], { INIT_CWD: dir, LANG: 'ko_KR.UTF-8' });
  assert.equal(init.code, 0, init.out);
  assert.ok(init.out.startsWith(`Created a Korean wiki at ${join(dir, 'my wiki')} `), init.out);
  const ok = await run(['doctor']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^pass {2}dotoriwiki\.yaml parses: 일상, 스터디, 미루기 아카이빙/m);
});

test('start reads the env file init wrote, a variable in the environment wins over it, and SIGTERM stops it', async () => {
  const { dir, env, envFile } = await machine();
  await initWiki(join(dir, 'wiki'), 'en', env);
  const token = parseEnvFile(await fs.readFile(envFile, 'utf8')).get('GATEWAY_TOKEN')!;
  const gateway = spawn(process.execPath, [cli, 'start'], { env: { ...env, PORT: '0', COLLECT_FEEDS: 'off' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<number | null>((done) => gateway.on('exit', done));
  const url = await new Promise<string>((done, fail) => {
    createInterface({ input: gateway.stderr! }).on('line', (line) => {
      const m = /"listening":"(http:[^"]+)"/.exec(line);
      if (m) done(m[1]!);
    });
    void exited.then((code) => fail(new Error(`start exited ${code}`)));
  });
  assert.notEqual(url, 'http://127.0.0.1:8787', 'PORT from the environment, not the file');
  const res = await fetch(`${url}/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(((await res.json()) as { domains: object }).domains), ['journal', 'learning', 'someday']);
  gateway.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('start without an env file exits 1 and says to run init', async () => {
  const { env, envFile } = await machine();
  const r = await execFileP(process.execPath, [cli, 'start'], { env }).then(() => assert.fail('start exited 0'), (e: { code: number; stderr: string }) => e);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`"fatal":"${envFile} does not exist. Run \`dotoriwiki init\` first`), r.stderr);
});

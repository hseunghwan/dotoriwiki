import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execRun } from '../src/enrich.ts';
import { initWiki } from '../src/init.ts';
import { install, tailscaleIPv4, uninstall, type ServiceControl } from '../src/install.ts';
import { parseEnvFile } from '../src/machine.ts';
import { PLATFORMS, renderPlist, renderUnit, servicePath, type ServiceSpec } from '../src/service.ts';

const tmp = (prefix: string) => fs.mkdtemp(join(process.env.DOTORIWIKI_TEST_TMP ?? tmpdir(), prefix));

async function script(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const SPEC: ServiceSpec = {
  program: ['/opt/node 24/bin/node', '/lib/node_modules/dotoriwiki/dist/cli.js', 'start'],
  path: '/opt/node 24/bin:/usr/bin:/bin',
  home: '/home/A&B',
  envFile: '/home/A&B/.config/dotoriwiki/gateway.env',
};

test('the plist launchd reads back holds the program, the environment, and the log under HOME', { skip: process.platform !== 'darwin' && 'plutil is macOS only' }, async () => {
  const dir = await tmp('dotoriwiki-plist-');
  const file = join(dir, 'p.plist');
  await fs.writeFile(file, renderPlist(SPEC));
  execFileSync('plutil', ['-lint', file]);
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<string, unknown>;
  assert.equal(plist.Label, PLATFORMS.launchd.name);
  assert.deepEqual(plist.ProgramArguments, SPEC.program);
  assert.deepEqual(plist.EnvironmentVariables, { PATH: SPEC.path, HOME: SPEC.home, DOTORIWIKI_ENV: SPEC.envFile });
  assert.equal(plist.KeepAlive, true);
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.StandardErrorPath, '/home/A&B/Library/Logs/dotoriwiki.log');
});

test('the systemd unit quotes spaces, and escapes the % and $ systemd would expand', () => {
  const unit = renderUnit({ ...SPEC, program: ['/opt/50%/node', '/x/$HOME/cli.js', 'start'], envFile: '/h/"q"/gateway.env' });
  const lines = unit.split('\n');
  assert.ok(lines.includes('ExecStart="/opt/50%%/node" "/x/$$HOME/cli.js" "start"'), unit);
  assert.ok(lines.includes('Environment="PATH=/opt/node 24/bin:/usr/bin:/bin"'), unit);
  assert.ok(lines.includes('Environment="DOTORIWIKI_ENV=/h/\\"q\\"/gateway.env"'), unit);
  assert.ok(lines.includes('Restart=always'));
  assert.ok(lines.includes('WantedBy=default.target'));
});

test('the service PATH lists the program folders first, then the platform folders, each once', () => {
  assert.equal(servicePath(PLATFORMS.systemd, ['/n/bin', '/usr/bin', '/n/bin']), '/n/bin:/usr/bin:/usr/local/bin:/bin');
  assert.equal(servicePath(PLATFORMS.launchd, []).split(':')[0], '/opt/homebrew/bin');
});

test('Tailscale: the first CLI that reports an IPv4 address wins, a missing or logged-out one is skipped', async () => {
  const dir = await tmp('dotoriwiki-ts-');
  const out = await script(dir, 'logged-out', 'echo "Logged out." >&2; exit 1');
  const app = await script(dir, 'app', 'printf "100.64.1.2\\n"');
  assert.equal(await tailscaleIPv4([join(dir, 'missing'), out, app], execRun), '100.64.1.2');
  assert.equal(await tailscaleIPv4([join(dir, 'missing'), out], execRun), null);
});

/** A temp HOME after `init`, a PATH holding stand-ins for claude and tailscale, and a control that records calls. */
async function machine() {
  const dir = await tmp('dotoriwiki-install-');
  const bin = join(dir, 'bin');
  await fs.mkdir(bin);
  await script(bin, 'claude', 'echo "9.9.9 (Claude Code)"');
  await script(bin, 'tailscale', 'echo 100.101.102.103; echo fd7a::1');
  const env: NodeJS.ProcessEnv = { HOME: join(dir, 'home'), PATH: `${bin}:/usr/bin:/bin` };
  await initWiki(join(dir, 'wiki'), 'en', env);
  const calls: string[] = [];
  const control: ServiceControl = {
    restart: async (file) => {
      calls.push(`restart ${file}`);
      return [];
    },
    remove: async (file) => {
      calls.push(`remove ${file}`);
      await fs.rm(file, { force: true });
    },
  };
  const envFile = join(dir, 'home', '.config', 'dotoriwiki', 'gateway.env');
  return { dir, bin, env, calls, envFile, deps: { platform: PLATFORMS.systemd, control, run: execRun } };
}

test('install moves HOST from 127.0.0.1 to the Tailscale address, records claude, writes the unit, and a rerun changes nothing', async () => {
  const { dir, bin, env, calls, envFile, deps } = await machine();
  const token = parseEnvFile(await fs.readFile(envFile, 'utf8')).get('GATEWAY_TOKEN');
  const program = [process.execPath, join(dir, 'cli.js')];

  const first = await install(env, program, deps);
  assert.deepEqual(first.changed, ['HOST', 'CLAUDE_BIN']);
  const vars = parseEnvFile(await fs.readFile(envFile, 'utf8'));
  assert.equal(vars.get('HOST'), '100.101.102.103');
  assert.equal(vars.get('CLAUDE_BIN'), join(bin, 'claude'));
  assert.equal(vars.get('GATEWAY_TOKEN'), token);
  assert.equal(first.config.host, '100.101.102.103');
  assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);

  const unitFile = join(dir, 'home', '.config', 'systemd', 'user', 'dotoriwiki.service');
  assert.equal(first.serviceFile, unitFile);
  const unit = await fs.readFile(unitFile, 'utf8');
  assert.ok(unit.includes(`ExecStart="${process.execPath}" "${join(dir, 'cli.js')}" "start"`), unit);
  assert.ok(unit.includes(`Environment="DOTORIWIKI_ENV=${envFile}"`), unit);
  assert.ok(unit.includes(`Environment="PATH=${join(process.execPath, '..')}:`) && unit.includes(bin), unit);

  const envBefore = await fs.readFile(envFile, 'utf8');
  const second = await install(env, program, deps);
  assert.deepEqual(second.changed, []);
  assert.equal(await fs.readFile(envFile, 'utf8'), envBefore);
  assert.equal(await fs.readFile(unitFile, 'utf8'), unit);
  assert.deepEqual(calls, [`restart ${unitFile}`, `restart ${unitFile}`]);

  const removed = await uninstall(env, deps);
  assert.deepEqual(removed, { serviceFile: unitFile, existed: true });
  assert.equal(await fs.access(unitFile).then(() => true, () => false), false);
  assert.equal(await fs.readFile(envFile, 'utf8'), envBefore, 'uninstall keeps the env file');
});

test('install keeps HOST=127.0.0.1 when the environment sets it, and keeps any other HOST the file has', async () => {
  const { env, envFile, deps, dir } = await machine();
  const program = [process.execPath, join(dir, 'cli.js')];
  assert.deepEqual((await install({ ...env, HOST: '127.0.0.1' }, program, deps)).changed, ['CLAUDE_BIN']);
  assert.equal(parseEnvFile(await fs.readFile(envFile, 'utf8')).get('HOST'), '127.0.0.1');

  await fs.writeFile(envFile, (await fs.readFile(envFile, 'utf8')).replace('HOST=127.0.0.1', 'HOST=100.1.1.1'));
  assert.deepEqual((await install(env, program, deps)).changed, []);
  assert.equal(parseEnvFile(await fs.readFile(envFile, 'utf8')).get('HOST'), '100.1.1.1');
});

test('install without an env file says to run init, and writes no service file', async () => {
  const dir = await tmp('dotoriwiki-noinit-');
  const env = { HOME: dir, PATH: '/usr/bin:/bin' };
  const control: ServiceControl = { restart: async () => assert.fail('restarted'), remove: async () => {} };
  await assert.rejects(install(env, [process.execPath, 'cli.js'], { platform: PLATFORMS.launchd, control, run: execRun }), /Run `dotoriwiki init` first/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('install refuses settings the gateway would refuse, before it writes the env file or the service file', async () => {
  const { dir, env, envFile, deps, calls } = await machine();
  await fs.writeFile(envFile, (await fs.readFile(envFile, 'utf8')).replace(/^WIKI_ROOT=.*$/m, 'WIKI_ROOT=wiki'));
  const before = await fs.readFile(envFile, 'utf8');
  await assert.rejects(install(env, [process.execPath, join(dir, 'cli.js')], deps), /WIKI_ROOT must be an absolute path/);
  assert.equal(await fs.readFile(envFile, 'utf8'), before);
  assert.equal(await fs.access(join(dir, 'home', '.config', 'systemd')).then(() => true, () => false), false);
  assert.deepEqual(calls, []);
});

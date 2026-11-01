import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, mergeEnv, parseEnvFile, withEnvFile } from '../src/machine.ts';

const loopback = (key: string, old: string) => key === 'HOST' && old === '127.0.0.1';

test('mergeEnv appends the keys the file lacks and keeps every value it has', () => {
  const before = '# mine\nPORT=9999\nGATEWAY_TOKEN=keep';
  const { text, changed } = mergeEnv(before, [['PORT', '8787'], ['GATEWAY_TOKEN', 'new'], ['HOST', '127.0.0.1'], ['CLAUDE_BIN', '/opt/my claude/claude']]);
  assert.deepEqual(changed, ['HOST', 'CLAUDE_BIN']);
  assert.equal(text, "# mine\nPORT=9999\nGATEWAY_TOKEN=keep\nHOST=127.0.0.1\nCLAUDE_BIN='/opt/my claude/claude'\n");
  assert.equal(parseEnvFile(text).get('CLAUDE_BIN'), '/opt/my claude/claude');
});

test('mergeEnv rewrites a line in place only where replace allows, and an equal value is no change', () => {
  const before = 'WIKI_ROOT=/w\nHOST=127.0.0.1\nPORT=8787\n';
  const moved = mergeEnv(before, [['HOST', '100.64.0.1'], ['PORT', '1']], loopback);
  assert.deepEqual(moved.changed, ['HOST']);
  assert.equal(moved.text, 'WIKI_ROOT=/w\nHOST=100.64.0.1\nPORT=8787\n');
  assert.deepEqual(mergeEnv(moved.text, [['HOST', '100.64.0.2']], loopback), { text: moved.text, changed: [] });
  assert.deepEqual(mergeEnv(before, [['HOST', '127.0.0.1']], loopback), { text: before, changed: [] });
});

test('mergeEnv on an empty or missing file writes only the entries', () => {
  assert.deepEqual(mergeEnv('', [['A', '1'], ['B', '2']]), { text: 'A=1\nB=2\n', changed: ['A', 'B'] });
});

test('withEnvFile: a variable set in the environment wins over the file', () => {
  const env = withEnvFile({ PORT: '0', HOME: '/h' }, 'PORT=8787\nWIKI_ROOT=/w\n');
  assert.equal(env.PORT, '0');
  assert.equal(env.WIKI_ROOT, '/w');
  assert.equal(env.HOME, '/h');
});

const base = { WIKI_ROOT: '/w', GATEWAY_TOKEN: '0123456789abcdef', HOME: '/h' };

test('claude bills the subscription by default, and an ANTHROPIC_API_KEY alone does not change that', () => {
  assert.deepEqual(loadConfig(base).claudeBilling, { kind: 'subscription' });
  assert.deepEqual(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-stray' }).claudeBilling, { kind: 'subscription' });
  assert.deepEqual(loadConfig({ ...base, CLAUDE_BILLING: 'subscription', ANTHROPIC_API_KEY: 'sk-ant-stray' }).claudeBilling, { kind: 'subscription' });
});

test('CLAUDE_BILLING=api bills the key from the env file, and the environment wins over the file', () => {
  const file = 'CLAUDE_BILLING=api\nANTHROPIC_API_KEY=sk-ant-file\n';
  assert.deepEqual(loadConfig(withEnvFile(base, file)).claudeBilling, { kind: 'api', apiKey: 'sk-ant-file' });
  assert.deepEqual(loadConfig(withEnvFile({ ...base, ANTHROPIC_API_KEY: 'sk-ant-shell' }, file)).claudeBilling, { kind: 'api', apiKey: 'sk-ant-shell' });
});

test('CLAUDE_BILLING=api without a key, or an unknown CLAUDE_BILLING, is a settings error that names the fix', () => {
  assert.throws(() => loadConfig({ ...base, CLAUDE_BILLING: 'api' }), /^Error: CLAUDE_BILLING=api needs ANTHROPIC_API_KEY\. Add it to the env file/);
  assert.throws(() => loadConfig({ ...base, CLAUDE_BILLING: 'api', ANTHROPIC_API_KEY: '  ' }), /CLAUDE_BILLING=api needs ANTHROPIC_API_KEY/);
  assert.throws(() => loadConfig({ ...base, CLAUDE_BILLING: 'API' }), /CLAUDE_BILLING must be subscription or api/);
});

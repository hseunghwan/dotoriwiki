import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyArgv } from '../src/claude.ts';
import { DEFAULT_MODELS, loadModels, parseModels, profileNames, routeLlm, type ModelChoice } from '../src/models.ts';
import type { ClassifyRequest, DomainName, EditRequest, Llm, ModelProfile } from '../src/wiki/index.ts';

const SPEC = {
  classify: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
  chat: { provider: 'claude', model: 'sonnet' },
  edit: {
    default: { provider: 'claude', model: 'sonnet' },
    뉴스: { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' },
  },
};

test('an absent models.json keeps the Claude defaults, which pass the same flags as before', async () => {
  assert.equal(loadModels(join(tmpdir(), 'llmwiki-no-such-models.json')), DEFAULT_MODELS);
  const argv = classifyArgv({ systemPrompt: '# 루트', text: '메모', domains: ['journal' as DomainName] }, DEFAULT_MODELS.classify as Extract<ModelChoice, { provider: 'claude' }>);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4), ['--model', 'haiku', '--effort', 'low']);
});

test('the spec example parses into profiles, and a profile key written in NFD is read as NFC', () => {
  const nfd = { ...SPEC, edit: { default: SPEC.edit.default, ['뉴스'.normalize('NFD')]: SPEC.edit.뉴스 } };
  for (const raw of [SPEC, nfd]) {
    const m = parseModels(raw);
    assert.deepEqual(m.classify, { provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(m.chat, { provider: 'claude', model: 'sonnet' });
    assert.deepEqual([...m.edit.profiles], [['뉴스', { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' }]]);
    assert.deepEqual(profileNames(m), ['default', '뉴스']);
  }
});

test('a role the file leaves out keeps its default', () => {
  const m = parseModels({ chat: { provider: 'claude', model: 'opus' } });
  assert.equal(m.classify, DEFAULT_MODELS.classify);
  assert.equal(m.edit, DEFAULT_MODELS.edit);
});

test('startup fails with a message naming the bad entry', async () => {
  const bad: [unknown, RegExp][] = [
    [{ classify: { provider: 'gemini', model: 'x' } }, /classify\.provider: expected one of claude, codex/],
    [{ classify: { provider: 'codex' } }, /classify\.model/],
    [{ classify: { provider: 'claude', model: 'haiku', effort: 'minimal' } }, /classify\.effort: claude takes one of/],
    [{ classify: { provider: 'codex', model: 'm', temperature: 1 } }, /classify: unknown key "temperature"/],
    [{ edit: { strong: { provider: 'claude', model: 'opus' } } }, /edit: expected \{"default"/],
    [{ edit: { default: { provider: 'claude', model: 'sonnet' }, strong: { provider: 'claude' } } }, /edit\."strong"\.model/],
    [{ chat: { provider: 'codex', model: 'gpt-6-luna' } }, /chat: only the claude provider/],
    [{ clasify: {} }, /unknown key "clasify"/],
    [[], /expected an object/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseModels(raw), message);
  const file = join(await fs.mkdtemp(join(tmpdir(), 'llmwiki-models-')), 'models.json');
  await fs.writeFile(file, '{ "classify": ');
  assert.throws(() => loadModels(file), new RegExp(`^Error: ${file}: `));
});

test('the router sends classify to its choice and each edit to its profile, or edit.default', async () => {
  const served: string[] = [];
  const llmFor = (c: ModelChoice): Llm => ({
    classify: async () => (served.push(`classify ${c.provider}:${c.model}`), { kind: 'no-answer', detail: '' }),
    edit: async (req) => (served.push(`edit ${req.modelProfile} ${c.provider}:${c.model}`), { kind: 'failed', reason: '' }),
  });
  const llm = routeLlm(parseModels(SPEC), llmFor);
  const edit = (modelProfile: string | null) => ({ modelProfile: modelProfile as ModelProfile | null }) as EditRequest;
  await llm.classify({} as ClassifyRequest);
  await llm.edit(edit('뉴스'));
  await llm.edit(edit(null));
  await llm.edit(edit('default'));
  assert.deepEqual(served, [
    'classify codex:gpt-6-luna',
    'edit 뉴스 codex:gpt-6.1-terra',
    'edit null claude:sonnet',
    'edit default claude:sonnet',
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyArgv } from '../src/claude.ts';
import { DEFAULT_MODELS, loadModels, parseModels, routeLlm, type ModelChoice } from '../src/models.ts';
import type { ClassifyRequest, DomainName, EditRequest, Llm } from '../src/wiki/index.ts';

const DOMAINS = ['개발소식지식베이스', '미루기 아카이빙', '스터디', '일상'] as DomainName[];
const SPEC = {
  classify: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
  chat: { provider: 'claude', model: 'sonnet' },
  edit: {
    default: { provider: 'claude', model: 'sonnet' },
    개발소식지식베이스: { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' },
  },
};

test('an absent models.json keeps the Claude defaults, which pass the same flags as before', async () => {
  assert.equal(loadModels(join(tmpdir(), 'llmwiki-no-such-models.json'), DOMAINS), DEFAULT_MODELS);
  const argv = classifyArgv({ systemPrompt: '# 루트', text: '메모', domains: DOMAINS }, DEFAULT_MODELS.classify as Extract<ModelChoice, { provider: 'claude' }>);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4), ['--model', 'haiku', '--effort', 'low']);
});

test('the spec example parses, and a domain key written in NFD still names the NFC domain', () => {
  const nfd = { ...SPEC, edit: { default: SPEC.edit.default, ['개발소식지식베이스'.normalize('NFD')]: SPEC.edit.개발소식지식베이스 } };
  for (const raw of [SPEC, nfd]) {
    const m = parseModels(raw, DOMAINS);
    assert.deepEqual(m.classify, { provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(m.chat, { provider: 'claude', model: 'sonnet' });
    assert.deepEqual([...m.edit.byDomain], [['개발소식지식베이스', { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' }]]);
  }
});

test('a role the file leaves out keeps its default', () => {
  const m = parseModels({ edit: { 스터디: { provider: 'codex', model: 'gpt-6.1-terra' } } }, DOMAINS);
  assert.equal(m.classify, DEFAULT_MODELS.classify);
  assert.equal(m.edit.default, DEFAULT_MODELS.edit.default);
});

test('startup fails with a message naming the bad entry', async () => {
  const bad: [unknown, RegExp][] = [
    [{ classify: { provider: 'gemini', model: 'x' } }, /classify\.provider: expected one of claude, codex/],
    [{ classify: { provider: 'codex' } }, /classify\.model/],
    [{ classify: { provider: 'claude', model: 'haiku', effort: 'minimal' } }, /classify\.effort: claude takes one of/],
    [{ classify: { provider: 'codex', model: 'm', temperature: 1 } }, /classify: unknown key "temperature"/],
    [{ edit: { 업무: { provider: 'claude', model: 'sonnet' } } }, /edit\."업무": no such domain/],
    [{ chat: { provider: 'codex', model: 'gpt-6-luna' } }, /chat: only the claude provider/],
    [{ clasify: {} }, /unknown key "clasify"/],
    [[], /expected an object/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseModels(raw, DOMAINS), message);
  const file = join(await fs.mkdtemp(join(tmpdir(), 'llmwiki-models-')), 'models.json');
  await fs.writeFile(file, '{ "classify": ');
  assert.throws(() => loadModels(file, DOMAINS), new RegExp(`^Error: ${file}: `));
});

test('the router sends classify to its choice and each edit to its domain choice or the default', async () => {
  const served: string[] = [];
  const llmFor = (c: ModelChoice): Llm => ({
    classify: async () => (served.push(`classify ${c.provider}:${c.model}`), { kind: 'no-answer', detail: '' }),
    edit: async (req) => (served.push(`edit ${req.domain} ${c.provider}:${c.model}`), { kind: 'failed', reason: '' }),
  });
  const llm = routeLlm(parseModels(SPEC, DOMAINS), llmFor);
  const edit = (domain: string) => ({ domain: domain as DomainName }) as EditRequest;
  await llm.classify({} as ClassifyRequest);
  await llm.edit(edit('개발소식지식베이스'));
  await llm.edit(edit('스터디'));
  await llm.edit(edit('새도메인'));
  assert.deepEqual(served, [
    'classify codex:gpt-6-luna',
    'edit 개발소식지식베이스 codex:gpt-6.1-terra',
    'edit 스터디 claude:sonnet',
    'edit 새도메인 claude:sonnet',
  ]);
});

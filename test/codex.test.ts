/**
 * The codex.ts decisions, fed with output recorded from codex-cli 0.164.0 on this machine:
 * classify.jsonl is a gpt-6-luna classifier call, edit.jsonl a gpt-6.1-terra edit run in a
 * scratch repo, auth-401 a run with no login, model-not-found a run with a made-up model,
 * server-500 a run against a local server answering 500, invalid-schema a run whose output
 * schema lacked additionalProperties.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finished } from '../src/cli-run.ts';
import { classifyArgv, codexCli, editArgv, porcelainPaths, toClassification, toEditResult, unavailableFrom } from '../src/codex.ts';
import type { CodexChoice } from '../src/models.ts';
import type { DomainName, EditRequest } from '../src/wiki/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'codex');
const jsonl = (name: string) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const finished = (events: Record<string, unknown>[], extra: Partial<Finished> = {}): Finished => ({ code: 0, timedOut: false, spawnError: null, stderr: '', events, ...extra });
const editReq = (cwd: string, onTouch: (p: string) => void = () => undefined): EditRequest => ({
  modelProfile: null, cwd, systemPrompt: '# 스터디', prompt: '- 메모', timeoutMs: 60_000, writableDir: 'wiki', verdicts: ['새 페이지'], onTouch, images: [],
});

test('a recorded classifier call parses to a classification', () => {
  assert.deepEqual(toClassification(finished(jsonl('classify.jsonl'))), {
    kind: 'classified', domain: '개발소식지식베이스', confidence: 0.94, reason: 'Next.js 16의 캐시 기본값 변경에 관한 외부 발표·기술 소식이다.',
  });
});

test('a recorded edit run yields its final structured verdict, not the narration before it', () => {
  assert.deepEqual(toEditResult(finished(jsonl('edit.jsonl'))), { kind: 'finished', verdict: '새 페이지', pages: ['wiki/small-pull-requests.md', 'wiki/old.md'] });
});

test('infrastructure trouble is Unavailable and spends no attempt; job trouble is failed', () => {
  const kind = (name: string) => unavailableFrom(finished(jsonl(name), { code: 1 }))?.reason.split(':')[0];
  assert.equal(kind('auth-401.jsonl'), 'auth');
  assert.equal(kind('model-not-found.jsonl'), 'model');
  assert.equal(kind('server-500.jsonl'), 'server');
  assert.equal(unavailableFrom(finished([{ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 3:00 PM." } }]))?.reason.split(':')[0], 'rate limited');
  assert.equal(toEditResult(finished([], { spawnError: 'spawn codex ENOENT', code: null })).kind, 'unavailable');
  assert.equal(toEditResult(finished([{ type: 'thread.started' }], { code: 1, stderr: 'panic' })).kind, 'unavailable', 'exit without a turn result');

  assert.equal(toEditResult(finished(jsonl('invalid-schema.jsonl'), { code: 1 })).kind, 'failed', 'a bad request is the job failing, not the service');
  assert.equal(toClassification(finished(jsonl('invalid-schema.jsonl'), { code: 1 })).kind, 'no-answer');
  assert.deepEqual(toEditResult(finished([{ type: 'turn.started' }], { timedOut: true, code: null })), { kind: 'failed', reason: 'edit run timed out' });
  assert.equal(toEditResult(finished([{ type: 'turn.completed' }])).kind, 'failed', 'no final message');
  assert.equal(toEditResult(finished([{ type: 'item.completed', item: { type: 'agent_message', text: '다 했다' } }, { type: 'turn.completed' }])).kind, 'failed', 'final message is not JSON');
  assert.equal(unavailableFrom(finished([...jsonl('auth-401.jsonl').slice(0, 3), ...jsonl('classify.jsonl').slice(2)])), null, 'a reconnect that recovered is no outage');
});

test('argv never bypasses the sandbox, ignores the user config, scopes edits to wiki/, and carries no prompt text', () => {
  const forbidden = ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', 'danger-full-access'];
  const choices: CodexChoice[] = [{ provider: 'codex', model: 'gpt-6-luna' }, ...(['minimal', 'low', 'medium', 'high', 'xhigh'] as const).map((effort) => ({ provider: 'codex', model: 'gpt-6.1-terra', effort }) as const)];
  for (const choice of choices) {
    const classify = classifyArgv(choice, '/s/classify.json');
    const edit = editArgv(editReq('/w/스터디'), choice, '/s/edit.json');
    assert.deepEqual(classify.slice(classify.indexOf('-s'), classify.indexOf('-s') + 2), ['-s', 'read-only']);
    assert.deepEqual(edit.slice(edit.indexOf('-s'), edit.indexOf('-s') + 4), ['-s', 'workspace-write', '-C', '/w/스터디/wiki']);
    for (const argv of [classify, edit]) {
      assert.equal(argv[0], 'exec');
      assert.ok(argv.includes('--ignore-user-config') && argv.includes('--ephemeral'));
      assert.ok(!argv.some((a) => forbidden.some((f) => a.includes(f))), argv.join(' '));
      assert.equal(argv.at(-1), '-', 'the prompt goes on stdin');
    }
  }
});

test('git status paths come back absolute from the repo top', () => {
  assert.deepEqual(porcelainPaths(' M 스터디/wiki/a.md\0?? 스터디/wiki/new dir/b.md\0 D 스터디/wiki/c.md\0', '/w'), ['/w/스터디/wiki/a.md', '/w/스터디/wiki/new dir/b.md', '/w/스터디/wiki/c.md']);
});

test('an edit reports every file the run changed under wiki/, modified, new, or deleted', async () => {
  const root = await fs.mkdtemp(join(process.env.LLMWIKI_TEST_TMP ?? tmpdir(), 'llmwiki-codex-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  const wiki = join(root, '스터디', 'wiki');
  await fs.mkdir(wiki, { recursive: true });
  await fs.writeFile(join(wiki, 'old.md'), '# old\n');
  await fs.writeFile(join(wiki, 'gone.md'), '# gone\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const bin = join(root, 'fake-codex.mjs');
  await fs.writeFile(bin, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
const w = process.argv[process.argv.indexOf('-C') + 1];
appendFileSync(w + '/old.md', 'more\\n');
unlinkSync(w + '/gone.md');
mkdirSync(w + '/새 폴더');
writeFileSync(w + '/새 폴더/new.md', '# new\\n');
const events = ${JSON.stringify(jsonl('edit.jsonl'))};
for (const e of events) console.log(JSON.stringify(e));
`);
  await fs.chmod(bin, 0o755);
  const touched: string[] = [];
  const codex = codexCli({ bin });
  const r = await codex.llm({ provider: 'codex', model: 'm' }).edit(editReq(join(root, '스터디'), (p) => touched.push(p)));
  const real = await fs.realpath(wiki);
  assert.equal(r.kind, 'finished');
  assert.deepEqual(touched.map((p) => p.normalize('NFC')).sort(), [join(real, 'gone.md'), join(real, 'old.md'), join(real, '새 폴더', 'new.md')].sort());
});

/**
 * The claude.ts decisions, fed with output recorded from claude 2.1.312 on this machine:
 * edit-escape.jsonl is a Haiku run told to write wiki/ok.md and ../escape.md under the scoped
 * allow rules (the second write was denied), classify.json a Haiku classifier call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatArgv, classifyArgv, editArgv, toClassification, toEditResult, unavailableFrom, writeAttempts } from '../src/claude.ts';
import type { Finished } from '../src/cli-run.ts';
import type { DomainName } from '../src/wiki/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'claude');
const jsonl = (name: string) => readFileSync(join(dir, name), 'utf8').split('\n').flatMap((l) => {
  try {
    return [JSON.parse(l) as Record<string, unknown>];
  } catch {
    return [];
  }
});
const finished = (events: Record<string, unknown>[], extra: Partial<Finished> = {}): Finished => ({ code: 0, timedOut: false, spawnError: null, stderr: '', events, ...extra });

test('a recorded edit run reports both write attempts, the denied one included, and its verdict', () => {
  const events = jsonl('edit-escape.jsonl');
  const attempts = events.flatMap(writeAttempts);
  assert.equal(attempts.length, 2);
  assert.match(attempts[0]!, /\/probe\/dom\/wiki\/ok\.md$/);
  assert.match(attempts[1]!, /\/probe\/escape\.md$/, 'the denied ../escape.md attempt is still reported');
  assert.deepEqual(toEditResult(finished(events)), { kind: 'finished', verdict: '새 페이지', pages: ['ok.md'] });
});

test('a recorded classifier call parses to a classification', () => {
  assert.deepEqual(toClassification(finished([JSON.parse(readFileSync(join(dir, 'classify.json'), 'utf8'))])), {
    kind: 'classified', domain: '스터디', confidence: 0.92,
    reason: '직접 해본 업무 경험에서 얻은 인사이트다. PR을 작게 쪼갰더니 리뷰 대기 시간이 줄었다는 1인칭 결과이므로 라우팅 기준 3번(업무 경험과 인사이트)에 해당한다. 바깥 소식이나 링크가 아니고 감정이나 일상 기록도 아니다.',
  });
});

test('infrastructure trouble is Unavailable and spends no attempt; job trouble is failed', () => {
  const now = 1_793_200_000_000;
  const limited = finished([
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_793_209_200 } },
    { type: 'result', is_error: true, result: 'Claude AI usage limit reached' },
  ]);
  assert.deepEqual(unavailableFrom(limited, now), { kind: 'unavailable', reason: 'rate limited: Claude AI usage limit reached', retryAfterMs: 9_200_000 });
  assert.equal(toEditResult(finished([], { spawnError: 'spawn claude ENOENT', code: null })).kind, 'unavailable');
  assert.equal(toEditResult(finished([], { code: 1, stderr: 'segfault' })).kind, 'unavailable', 'exit without a result');
  assert.equal(toEditResult(finished([{ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }])).kind, 'unavailable');
  assert.deepEqual(toEditResult(finished([], { timedOut: true, code: null })), { kind: 'failed', reason: 'edit run timed out' });
  assert.deepEqual(toEditResult(finished([{ type: 'result', is_error: false, result: 'done' }])), { kind: 'failed', reason: 'no structured verdict in the result' });
  assert.equal(toClassification(finished(jsonl('resume-missing.jsonl'))).kind, 'no-answer');
});

test('argv keeps writes scoped, never uses acceptEdits or --bare, and carries no prompt text', () => {
  const edit = editArgv({ modelProfile: null, locale: 'ko', cwd: '/w/스터디', systemPrompt: '# 스터디', prompt: '- 메모', timeoutMs: 1, writableDir: 'wiki', verdicts: ['created'], onTouch: () => undefined, images: [] }, { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(edit.slice(edit.indexOf('--allowedTools'), edit.indexOf('--allowedTools') + 6), ['--allowedTools', 'Read', 'Glob', 'Grep', 'Edit(./wiki/**)', 'Write(./wiki/**)']);
  const all = [edit, classifyArgv({ locale: 'ko', systemPrompt: '# 루트', text: '- 메모', domains: ['스터디' as DomainName] }, { provider: 'claude', model: 'haiku', effort: 'low' }), chatArgv({ cwd: '/w', systemPrompt: '# 루트', message: '- 질문', resume: null }, { provider: 'claude', model: 'sonnet' })];
  for (const argv of all) {
    assert.ok(argv.includes('--safe-mode'));
    assert.ok(!argv.includes('--bare') && !argv.includes('acceptEdits'));
    assert.ok(!argv.some((a) => a.startsWith('- ')), 'the prompt goes on stdin');
  }
});

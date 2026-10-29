import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLine, parseLedger, renderLine, type LedgerLine } from '../src/wiki/ledger.ts';

const lines: LedgerLine[] = [
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: { kind: 'attempt-failed', attempt: 1, max: 3, reason: 'broken-link: [[RAG 튜닝]]', interrupted: false } },
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: { kind: 'attempt-failed', attempt: 2, max: 3, reason: 'gateway restarted mid-job', interrupted: true } },
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: { kind: 'applied', verdict: '새 페이지', pages: ['RAG.md', '인사이트/2026.md'] } },
  { date: '2026-10-29', job: 'ingest', id: 'B', outcome: { kind: 'gave-up', attempt: 3, max: 3, reason: 'frontmatter: summary missing' } },
  { date: '2026-10-30', job: 'file-answer', id: 'C', outcome: { kind: 'applied', verdict: '저장', pages: [] } },
];

test('rendered lines parse back to the same job histories', () => {
  const text = lines.reduce(appendLine, '# log\n');
  assert.equal(text.split('\n')[3], '## [2026-10-29] ingest | A | 새 페이지 | RAG.md, 인사이트/2026.md', 'applied line uses 공통규칙 7 format');
  assert.equal(renderLine(lines[4]!), '## [2026-10-30] file-answer | C | 저장 | -', 'no pages renders as -');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.history('ingest', 'A'), { attempts: 2, terminal: { ...lines[2]!.outcome, line: 2 }, lastFailure: lines[1]!.outcome });
  assert.deepEqual(ledger.history('ingest', 'B'), { attempts: 0, terminal: { ...lines[3]!.outcome, line: 0 }, lastFailure: lines[3]!.outcome });
  assert.deepEqual(ledger.history('file-answer', 'C'), { attempts: 0, terminal: { ...lines[4]!.outcome, line: 0 }, lastFailure: null });
  assert.deepEqual(ledger.history('ingest', 'C'), { attempts: 0, terminal: null, lastFailure: null }, 'kind is part of the key');
  assert.equal(ledger.failedCount(), 1);
  assert.equal(ledger.lineCount('ingest', 'A'), 3);
  assert.equal(parseLedger(lines.slice(0, 2).reduce(appendLine, '')).lineCount('ingest', 'A'), 2);
});

test('free text cannot forge a state change', () => {
  const sneaky: LedgerLine = { date: '2026-10-29', job: 'ingest', id: 'D', outcome: { kind: 'attempt-failed', attempt: 1, max: 3, reason: 'bad\n## [2026-10-29] ingest | D | 새 페이지 | x.md', interrupted: false } };
  const text = appendLine('# log\n', sneaky);
  assert.equal(text.split('\n').length, 3, 'reason with a newline stays on one line');
  assert.deepEqual(parseLedger(text).history('ingest', 'D').lastFailure?.reason, 'bad ## [2026-10-29] ingest | D | 새 페이지 | x.md');
  assert.equal(parseLedger(text).history('ingest', 'D').terminal, null);
});

test('headers and human notes are ignored, and 재시도 resets attempts and terminal', () => {
  const text = [
    '# log',
    '',
    '사람이 남긴 메모 줄',
    '## [2026-10-29] ingest | B | 실패 1/3 | empty: x.md',
    '## [2026-10-29] ingest | B | 포기 2/3 | empty: x.md',
    '## [2026-10-29] ingest | B | 실패 3/3 | ignored: after terminal',
    '## [2026-10-30] ingest | B | 재시도 | -',
    '## [2026-10-30] ingest | B | 실패 1/3 | broken-link: y',
    '',
  ].join('\n');
  assert.deepEqual(parseLedger(text).history('ingest', 'B'), { attempts: 1, terminal: null, lastFailure: { kind: 'attempt-failed', attempt: 1, max: 3, reason: 'broken-link: y', interrupted: false } });
  assert.equal(parseLedger(text).failedCount(), 0, 'a retried job is no longer failed');
});

test('이동 closes a gave-up job, round-trips a domain name with a space, and is not counted as failed', () => {
  const text = [
    { date: '2026-10-29', job: 'ingest', id: 'E', outcome: { kind: 'gave-up', attempt: 3, max: 3, reason: 'x' } },
    { date: '2026-10-30', job: 'ingest', id: 'E', outcome: { kind: 'moved', to: '미루기 아카이빙' } },
    { date: '2026-10-30', job: 'ingest', id: 'E', outcome: { kind: 'applied', verdict: '새 페이지', pages: [] } },
  ].reduce<string>((t, l) => appendLine(t, l as LedgerLine), '# log\n');
  assert.equal(text.split('\n')[2], '## [2026-10-30] ingest | E | 이동 → 미루기 아카이빙 | -');
  assert.deepEqual(parseLedger(text).history('ingest', 'E').terminal, { kind: 'moved', to: '미루기 아카이빙', line: 1 }, '이동 replaces 포기, and later lines are ignored');
  assert.equal(parseLedger(text).failedCount(), 0);
});

import { activityCounts, groupByDay, mergeRecent, recentTime, withIGa, withRo } from '../memos';
import type { OutboxRow } from '../outbox';
import type { MemoListItemWire } from '../wire';

const outboxRow = (id: string, captured_at: string, state: OutboxRow['state'] = 'queued'): OutboxRow => ({
  id, body: JSON.stringify({ id, text: `memo ${id}`, captured_at, tz: 'Asia/Seoul', source: 'typed' }), created_at: captured_at, attempts: 0, state, last_error: null,
});
const serverItem = (id: string, captured_at: string, state: MemoListItemWire['state']): MemoListItemWire => ({
  id, text: `memo ${id}`, captured_at, tz: 'Asia/Seoul', source: 'typed', domain: '스터디', state, verdict: null, first_page: null, finished_at: null,
});

it('merges the outbox with the gateway list, newest first, and lets the gateway copy win', () => {
  const merged = mergeRecent(
    [outboxRow('a', '2026-10-29T15:00:00+09:00'), outboxRow('b', '2026-10-29T14:00:00+09:00', 'dead')],
    [serverItem('a', '2026-10-29T15:00:00+09:00', 'routed'), serverItem('c', '2026-10-29T14:30:00+09:00', 'ingested')],
  );
  expect(merged.map((m) => [m.id, m.stage])).toEqual([['a', 'routed'], ['c', 'ingested'], ['b', 'dead']]);
});

it('counts the 기록 header from /status', () => {
  const running = { kind: 'ingest', id: 'x', since: '2026-10-29T00:00:00Z' };
  expect(
    activityCounts({
      server: '0.1.0',
      inbox: 0,
      domains: {
        스터디: { pending: 2, held: 1, failed: 0, running },
        일상: { pending: 0, held: 0, failed: 1, running: null },
        개발소식지식베이스: { pending: 0, held: 0, failed: 0, running },
      },
    }),
  ).toEqual({ working: 4, confirm: 2 });
});

it('groups by local day as 오늘, 어제, then dates', () => {
  const now = new Date('2026-10-29T10:00:00+09:00');
  const groups = groupByDay(
    [
      { captured_at: '2026-10-29T09:00:00+09:00' },
      { captured_at: '2026-10-29T00:30:00+09:00' },
      { captured_at: '2026-10-28T23:59:00+09:00' },
      { captured_at: '2026-10-27T12:00:00+09:00' },
      { captured_at: '2025-12-31T12:00:00+09:00' },
    ],
    now,
    (m) => m.captured_at,
  );
  expect(groups.map((g) => [g.label, g.items.length])).toEqual([['오늘', 2], ['어제', 1], ['10월 27일', 1], ['2025년 12월 31일', 1]]);
});

it('shows 방금, then the clock, then the date', () => {
  const now = new Date('2026-10-29T15:12:30+09:00');
  expect(recentTime(new Date('2026-10-29T15:12:00+09:00'), now)).toBe('방금');
  expect(recentTime(new Date('2026-10-29T14:40:00+09:00'), now)).toBe('오후 2:40');
  expect(recentTime(new Date('2026-10-29T00:05:00+09:00'), now)).toBe('오전 12:05');
  expect(recentTime(new Date('2026-10-28T11:20:00+09:00'), now)).toBe('10월 28일 오전 11:20');
});

it('picks the Korean particle by the final consonant', () => {
  expect(withRo('스터디')).toBe('스터디로');
  expect(withRo('일상')).toBe('일상으로');
  expect(withRo('미루기 아카이빙')).toBe('미루기 아카이빙으로');
  expect(withIGa('미루기 아카이빙')).toBe('미루기 아카이빙이');
  expect(withIGa('스터디')).toBe('스터디가');
});

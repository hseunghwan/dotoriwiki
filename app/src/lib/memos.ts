import type { OutboxRow } from './outbox';
import type { MemoListItemWire, MemoRequest, MemoStateWire, StatusResponse } from './wire';

export type Tone = 'wait' | 'route' | 'done' | 'warn' | 'bad';

/** Where a memo is, from the phone's point of view: still in the outbox, or known to the gateway. */
export type Stage = 'queued' | 'dead' | MemoStateWire;

export const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  queued: { label: '전송 대기', tone: 'wait' },
  dead: { label: '보내지 못함', tone: 'bad' },
  inbox: { label: '받음', tone: 'wait' },
  held: { label: '확인 필요', tone: 'warn' },
  routed: { label: '정리 대기', tone: 'route' },
  running: { label: '정리 중', tone: 'route' },
  ingested: { label: '정리됨', tone: 'done' },
  failed: { label: '실패', tone: 'bad' },
};

export type RecentMemo = {
  id: string;
  text: string;
  captured_at: string;
  stage: Stage;
  domain: string | null;
  first_page: string | null;
  verdict: string | null;
};

function fromOutbox(row: OutboxRow): RecentMemo | null {
  try {
    const m = JSON.parse(row.body) as MemoRequest;
    return { id: row.id, text: m.text, captured_at: m.captured_at, stage: row.state, domain: null, first_page: null, verdict: null };
  } catch {
    return null;
  }
}

const fromServer = (m: MemoListItemWire): RecentMemo => ({
  id: m.id, text: m.text, captured_at: m.captured_at, stage: m.state, domain: m.domain, first_page: m.first_page, verdict: m.verdict,
});

/** Outbox rows and GET /memos, deduped by id. The gateway's copy wins: it knows more than "not sent yet". */
export function mergeRecent(outbox: readonly OutboxRow[], server: readonly MemoListItemWire[]): RecentMemo[] {
  const byId = new Map<string, RecentMemo>();
  for (const row of outbox) {
    const r = fromOutbox(row);
    if (r) byId.set(r.id, r);
  }
  for (const m of server) byId.set(m.id, fromServer(m));
  return [...byId.values()].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || (a.id < b.id ? 1 : -1));
}

/** 기록 tab header, per 앱-실패문구.md: running domains plus pending, and held plus failed. */
export function activityCounts(status: StatusResponse): { working: number; confirm: number } {
  let working = 0;
  let confirm = 0;
  for (const d of Object.values(status.domains)) {
    working += (d.running ? 1 : 0) + d.pending;
    confirm += d.held + d.failed;
  }
  return { working, confirm };
}

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 오후 3:12 */
export function clock12(d: Date): string {
  const h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}`;
}

/** 15:12 */
export const clock24 = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const monthDay = (d: Date): string => `${d.getMonth() + 1}월 ${d.getDate()}일`;

/** 오늘, 어제, or 10월 27일, in the phone's local time. */
export function dayLabel(d: Date, now: Date): string {
  if (sameDay(d, now)) return '오늘';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return '어제';
  return d.getFullYear() === now.getFullYear() ? monthDay(d) : `${d.getFullYear()}년 ${monthDay(d)}`;
}

/** The 메모 tab's row time: 방금, 오후 3:12 today, 10월 27일 오후 3:12 before. */
export function recentTime(d: Date, now: Date): string {
  if (now.getTime() - d.getTime() < 60_000) return '방금';
  return sameDay(d, now) ? clock12(d) : `${monthDay(d)} ${clock12(d)}`;
}

export type DayGroup<T> = { label: string; items: T[] };

/** Items arrive newest first by `when`, so groups come out in order without sorting. */
export function groupByDay<T>(items: readonly T[], now: Date, when: (item: T) => string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(when(item)), now);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** 스터디로, 미루기 아카이빙으로: 로 after a vowel or ㄹ, 으로 after other final consonants. */
export function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = code >= 0 && code < 11172 ? code % 28 : 0;
  return word + (jong === 0 || jong === 8 ? '로' : '으로');
}

/** 이 or 가, for "<domain>이 맞아요". */
export function withIGa(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = code >= 0 && code < 11172 ? code % 28 : 0;
  return word + (jong === 0 ? '가' : '이');
}

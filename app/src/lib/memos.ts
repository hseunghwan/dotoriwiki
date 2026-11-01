import { copy } from '../text';
import type { OutboxFile, OutboxRow } from './outbox';
import { photoCount } from './photos';
import type { MemoListItemWire, MemoRequest, MemoStateWire, StatusResponse } from './wire';

export type Tone = 'wait' | 'route' | 'done' | 'warn' | 'bad';

/** Where a memo is, from the phone's point of view: still in the outbox, or known to the gateway. */
export type Stage = 'queued' | 'dead' | MemoStateWire;

export const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  queued: { label: copy.stage.queued, tone: 'wait' },
  dead: { label: copy.stage.dead, tone: 'bad' },
  inbox: { label: copy.stage.inbox, tone: 'wait' },
  held: { label: copy.stage.held, tone: 'warn' },
  routed: { label: copy.stage.routed, tone: 'route' },
  running: { label: copy.stage.running, tone: 'route' },
  ingested: { label: copy.stage.ingested, tone: 'done' },
  failed: { label: copy.stage.failed, tone: 'bad' },
};

/** The verdict in the phone's language. An older gateway sends no verdict_id, and text from before the gateway has a null one. */
export const verdictText = (m: Pick<MemoListItemWire, 'verdict' | 'verdict_id'>): string | null =>
  (m.verdict_id && copy.verdict[m.verdict_id]) || m.verdict;

export type RecentMemo = {
  id: string;
  text: string;
  captured_at: string;
  stage: Stage;
  domain: string | null;
  first_page: string | null;
  verdict: string | null;
  photos: number;
  /** file:// copies of a row still in the outbox, for its thumbnails. Empty once the gateway has it. */
  local: string[];
};

function fromOutbox(row: OutboxRow, local: string[]): RecentMemo | null {
  try {
    const m = JSON.parse(row.body) as MemoRequest;
    return { id: row.id, text: m.text, captured_at: m.captured_at, stage: row.state, domain: null, first_page: null, verdict: null, photos: photoCount(m), local };
  } catch {
    return null;
  }
}

const fromServer = (m: MemoListItemWire): RecentMemo => ({
  id: m.id, text: m.text, captured_at: m.captured_at, stage: m.state, domain: m.domain, first_page: m.first_page, verdict: verdictText(m), photos: m.photos ?? 0, local: [],
});

/** Outbox rows and GET /memos, deduped by id. The gateway's copy wins: it knows more than "not sent yet". */
export function mergeRecent(outbox: readonly OutboxRow[], server: readonly MemoListItemWire[], files: readonly OutboxFile[] = []): RecentMemo[] {
  const byId = new Map<string, RecentMemo>();
  for (const row of outbox) {
    const r = fromOutbox(row, files.filter((f) => f.memo_id === row.id).map((f) => f.path));
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

/** 오후 3:12, 3:12 PM */
export const clock12 = (d: Date): string => copy.time.clock(d);

/** 15:12 */
export const clock24 = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const monthDay = (d: Date): string => copy.time.monthDay(d);

/** Today, yesterday, or the date, in the phone's local time. */
export function dayLabel(d: Date, now: Date): string {
  if (sameDay(d, now)) return copy.time.today;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return copy.time.yesterday;
  return d.getFullYear() === now.getFullYear() ? monthDay(d) : copy.time.otherYear(d);
}

/** The 메모 tab's row time: just now, the clock today, the date and clock before. */
export function recentTime(d: Date, now: Date): string {
  if (now.getTime() - d.getTime() < 60_000) return copy.time.justNow;
  return sameDay(d, now) ? clock12(d) : copy.time.dateTime(d);
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

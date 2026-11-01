/**
 * The ledger parser P2 replaced, copied verbatim from src/wiki/ledger.ts at 5c579f9. Only
 * scripts/ledger-audit.ts and its test import it: it is the oracle for what a committed line
 * meant before P2. Never edit it to match the new parser.
 */

import type { JobKind } from '../src/wiki/index.ts';

export type LedgerOutcome =
  | { readonly kind: 'applied'; readonly verdict: string; readonly pages: readonly string[] }
  | { readonly kind: 'attempt-failed'; readonly attempt: number; readonly max: number; readonly reason: string; readonly interrupted: boolean }
  | { readonly kind: 'gave-up'; readonly attempt: number; readonly max: number; readonly reason: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'moved'; readonly to: string };

export type LedgerLine = {
  readonly date: string;
  readonly job: JobKind;
  readonly id: string;
  readonly outcome: LedgerOutcome;
};

export type Terminal = Extract<LedgerOutcome, { readonly kind: 'applied' | 'gave-up' | 'moved' }>;
export type Failure = Extract<LedgerOutcome, { readonly kind: 'attempt-failed' | 'gave-up' }>;

export type JobHistory = {
  /** 실패 and 중단 lines since the latest 재시도. */
  readonly attempts: number;
  /**
   * First terminal line since the latest 재시도, except that 이동 replaces 포기; later lines are
   * ignored until the next 재시도. `line` counts the job's own lines from 0, so it names the
   * commit that appended this one.
   */
  readonly terminal: (Terminal & { readonly line: number }) | null;
  /** The latest 실패, 중단, or 포기 line, kept across 재시도 so a rerun is told why the last one failed. */
  readonly lastFailure: Failure | null;
};

export type Ledger = {
  history(kind: JobKind, id: string): JobHistory;
  /** Compared between HEAD and a marker's base, this tells "committed, marker left" from "died mid-job". */
  lineCount(kind: JobKind, id: string): number;
  failedCount(): number;
};

const LINE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z][a-z-]*) \| (\S+) \| (.+?) \| (.*)$/;
const ATTEMPT = /^(실패|중단|포기) (\d+)\/(\d+)$/;
const MOVED = /^이동 → (.+)$/;
const EMPTY: JobHistory = { attempts: 0, terminal: null, lastFailure: null };

type Raw = { readonly kind: string; readonly id: string; readonly outcome: LedgerOutcome };

function parseOutcome(third: string, fourth: string): LedgerOutcome {
  if (third === '재시도') return { kind: 'retry' };
  const moved = MOVED.exec(third);
  if (moved) return { kind: 'moved', to: moved[1]! };
  const m = ATTEMPT.exec(third);
  if (m) {
    const attempt = Number(m[2]);
    const max = Number(m[3]);
    if (m[1] === '포기') return { kind: 'gave-up', attempt, max, reason: fourth };
    return { kind: 'attempt-failed', attempt, max, reason: fourth, interrupted: m[1] === '중단' };
  }
  return { kind: 'applied', verdict: third, pages: fourth === '-' || fourth === '' ? [] : fourth.split(', ') };
}

/** `${kind}:${id}` for a ledger line, null for any other line. */
export function lineKey(line: string): string | null {
  const m = LINE.exec(line.trimEnd());
  return m ? `${m[2]}:${m[3]}` : null;
}

function parseRaw(text: string): readonly Raw[] {
  const out: Raw[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trimEnd());
    if (!m) continue;
    out.push({ kind: m[2]!, id: m[3]!, outcome: parseOutcome(m[4]!.trim(), m[5]!.trim()) });
  }
  return out;
}

function fold(lines: readonly Raw[]): JobHistory {
  let h: { attempts: number; terminal: JobHistory['terminal']; lastFailure: Failure | null } = { ...EMPTY };
  lines.forEach(({ outcome }, line) => {
    if (outcome.kind === 'retry') {
      h = { attempts: 0, terminal: null, lastFailure: h.lastFailure };
      return;
    }
    // 이동 closes a job that gave up, so it overrides 포기; an applied job is never moved.
    if (outcome.kind === 'moved') {
      if (h.terminal?.kind !== 'applied') h.terminal = { ...outcome, line };
      return;
    }
    if (h.terminal) return;
    if (outcome.kind === 'applied') h.terminal = { ...outcome, line };
    else if (outcome.kind === 'gave-up') {
      h.terminal = { ...outcome, line };
      h.lastFailure = outcome;
    } else {
      h.attempts += 1;
      h.lastFailure = outcome;
    }
  });
  return h;
}

export function parseLedger(text: string): Ledger {
  const byKey = new Map<string, Raw[]>();
  for (const raw of parseRaw(text)) {
    const key = `${raw.kind}:${raw.id}`;
    const list = byKey.get(key);
    if (list) list.push(raw);
    else byKey.set(key, [raw]);
  }
  const histories = new Map<string, JobHistory>();
  for (const [key, lines] of byKey) histories.set(key, fold(lines));
  return {
    history: (kind, id) => histories.get(`${kind}:${id}`) ?? EMPTY,
    lineCount: (kind, id) => byKey.get(`${kind}:${id}`)?.length ?? 0,
    failedCount: () => [...histories.values()].filter((h) => h.terminal?.kind === 'gave-up').length,
  };
}


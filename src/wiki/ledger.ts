/**
 * log.md as the ledger. This file is the only reader and writer of the line format.
 * Pure: text in, values out.
 *
 * The line format is 공통규칙 7:
 *
 *   ## [2026-10-29] ingest | 01JB8Z… | 새 페이지 | RAG.md, 인사이트/2026.md        applied
 *   ## [2026-10-29] ingest | 01JB8Z… | 정리할 거리 없음 | -                       applied
 *   ## [2026-10-29] file-answer | 01JB90… | 저장 | answers/2026-10-29 RAG.md     applied
 *   ## [2026-10-29] ingest | 01JB8Z… | 실패 1/3 | broken-link: [[RAG 튜닝]]      attempt failed
 *   ## [2026-10-29] ingest | 01JB8Z… | 중단 2/3 | gateway restarted mid-job      attempt interrupted
 *   ## [2026-10-29] ingest | 01JB8Z… | 포기 3/3 | frontmatter: summary missing   gave up (terminal)
 *   ## [2026-10-29] ingest | 01JB8Z… | 재시도 | -                               human asked for a retry
 *   ## [2026-10-29] ingest | 01JB8Z… | 이동 → 스터디 | -                        moved to another domain (terminal)
 *
 * Only the 실패/중단/포기/재시도/이동 values in the third field carry meaning. Any other text there is
 * the model's verdict and counts as applied, so the model's wording can never change state.
 * Lines that do not match (the `# log` header, anything a human adds) are ignored.
 */

import type { JobKind } from './index.ts';

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

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export function renderLine(line: LedgerLine): string {
  const o = line.outcome;
  const [third, fourth] =
    o.kind === 'applied' ? [o.verdict.replaceAll('|', '/'), o.pages.length ? o.pages.join(', ') : '-']
    : o.kind === 'attempt-failed' ? [`${o.interrupted ? '중단' : '실패'} ${o.attempt}/${o.max}`, o.reason]
    : o.kind === 'gave-up' ? [`포기 ${o.attempt}/${o.max}`, o.reason]
    : o.kind === 'moved' ? [`이동 → ${o.to.replaceAll('|', '/')}`, '-']
    : ['재시도', '-'];
  return `## [${line.date}] ${line.job} | ${line.id} | ${oneLine(third)} | ${oneLine(fourth) || '-'}`;
}

export function appendLine(text: string, line: LedgerLine): string {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${renderLine(line)}\n`;
}

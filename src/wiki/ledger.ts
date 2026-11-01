/**
 * log.md as the ledger. This file is the only reader and writer of the line format.
 * Pure: text in, values out.
 *
 * The line format is 공통규칙 7. A line is written in the wiki's locale and read in every locale:
 *
 *   ## [2026-10-29] ingest | 01JB8Z… | 새 페이지 | RAG.md, 인사이트/2026.md          ko  applied
 *   ## [2026-10-29] ingest | 01JB8Z… | new page | RAG.md, insights/2026.md         en  applied
 *   ## [2026-10-29] file-answer | 01JB90… | 저장 | answers/2026-10-29 RAG.md       ko  applied
 *   ## [2026-10-29] ingest | 01JB8Z… | 실패 1/3 | broken-link …                    ko  attempt failed
 *   ## [2026-10-29] ingest | 01JB8Z… | interrupted 2/3 | gateway stopped mid-job   en  attempt interrupted
 *   ## [2026-10-29] ingest | 01JB8Z… | gave up 3/3 | frontmatter …                en  gave up (terminal)
 *   ## [2026-10-29] ingest | 01JB8Z… | 재시도 | -                                 ko  human asked for a retry
 *   ## [2026-10-29] ingest | 01JB8Z… | moved → someday | -                       en  moved to another domain (terminal)
 *
 * The third field carries the meaning, in the words of LEDGER_WORDS. The parser reads every
 * locale's words, so `locale` decides how a line is written and never how it is read. Other text
 * in the third field is a verdict from before the gateway and counts as applied. A `<word> k/N`
 * whose word no locale has is inert: it keeps its place in the job's line count and changes no
 * state. Lines that do not match LINE (the `# log` header, anything a human adds) are ignored.
 */

import { isDeepStrictEqual } from 'node:util';
import type { Locale } from './config.ts';
import type { JobKind } from './index.ts';

export const VERDICTS = ['created', 'updated', 'conflict', 'unchanged', 'saved'] as const;
export type VerdictId = (typeof VERDICTS)[number];
/** An applied line's verdict: one the gateway writes, or text it never wrote. */
export type Verdict = VerdictId | { readonly unknown: string };

type Outcome<V extends Verdict> =
  | { readonly kind: 'applied'; readonly verdict: V; readonly pages: readonly string[] }
  | { readonly kind: 'attempt-failed'; readonly attempt: number; readonly max: number; readonly reason: string; readonly interrupted: boolean }
  | { readonly kind: 'gave-up'; readonly attempt: number; readonly max: number; readonly reason: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'moved'; readonly to: string };

/** What a committed line says. */
export type LedgerOutcome = Outcome<Verdict>;
/** What the gateway writes. It never writes a verdict it could not read back. */
export type NewOutcome = Outcome<VerdictId>;

export type LedgerLine = {
  readonly date: string;
  readonly job: JobKind;
  readonly id: string;
  readonly outcome: NewOutcome;
};

export type Terminal = Extract<LedgerOutcome, { readonly kind: 'applied' | 'gave-up' | 'moved' }>;
export type Failure = Extract<LedgerOutcome, { readonly kind: 'attempt-failed' | 'gave-up' }>;

export type JobHistory = {
  /** Failed and interrupted lines since the latest retry. */
  readonly attempts: number;
  /**
   * First terminal line since the latest retry, except that a move replaces a give-up; later
   * lines are ignored until the next retry. `line` counts the job's own lines from 0, so it
   * names the commit that appended this one.
   */
  readonly terminal: (Terminal & { readonly line: number }) | null;
  /** The latest failed, interrupted, or gave-up line, kept across retries so a rerun is told why the last one failed. */
  readonly lastFailure: Failure | null;
};

export type Ledger = {
  history(kind: JobKind, id: string): JobHistory;
  /** Compared between HEAD and a marker's base, this tells "committed, marker left" from "died mid-job". */
  lineCount(kind: JobKind, id: string): number;
  failedCount(): number;
};

export type LedgerWords = {
  readonly retry: string;
  readonly failed: string;
  readonly interrupted: string;
  readonly gaveUp: string;
  readonly moved: string;
  readonly verdicts: { readonly [V in VerdictId]: string };
};

/**
 * The words of the third field, by locale. A word is in someone's committed log.md from the first
 * release that writes it, so it never changes and never goes away. test/fixture/ledger/<locale>.md
 * must keep folding.
 */
export const LEDGER_WORDS: { readonly [L in Locale]: LedgerWords } = {
  ko: {
    retry: '재시도', failed: '실패', interrupted: '중단', gaveUp: '포기', moved: '이동',
    verdicts: { created: '새 페이지', updated: '기존 페이지 수정', conflict: '충돌', unchanged: '정리할 거리 없음', saved: '저장' },
  },
  en: {
    retry: 'retry', failed: 'failed', interrupted: 'interrupted', gaveUp: 'gave up', moved: 'moved',
    verdicts: { created: 'new page', updated: 'updated page', conflict: 'conflict', unchanged: 'nothing to file', saved: 'saved' },
  },
};

type Meaning =
  | { readonly kind: 'retry' }
  | { readonly kind: 'applied'; readonly verdict: VerdictId }
  | { readonly kind: 'attempt'; readonly as: 'failed' | 'interrupted' | 'gave-up' }
  | { readonly kind: 'moved' };

const LINE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z][a-z-]*) \| (\S+) \| (.+?) \| (.*)$/;
const MOVED = /^(.+?) → (.+)$/;
const ATTEMPT = /^(.+) (\d+)\/(\d+)$/;
const EMPTY: JobHistory = { attempts: 0, terminal: null, lastFailure: null };

/** Every locale's words in one map. A word with two meanings, or a bare word shaped like an attempt or a move, throws. */
export function readTable(locales: readonly LedgerWords[]): ReadonlyMap<string, Meaning> {
  const out = new Map<string, Meaning>();
  const add = (word: string, m: Meaning) => {
    const had = out.get(word);
    if (had && !isDeepStrictEqual(had, m)) throw new Error(`ledger word "${word}" has two meanings`);
    if ((m.kind === 'retry' || m.kind === 'applied') && (ATTEMPT.test(word) || MOVED.test(word))) throw new Error(`ledger word "${word}" reads as an attempt or a move`);
    out.set(word, m);
  };
  for (const w of locales) {
    add(w.retry, { kind: 'retry' });
    add(w.failed, { kind: 'attempt', as: 'failed' });
    add(w.interrupted, { kind: 'attempt', as: 'interrupted' });
    add(w.gaveUp, { kind: 'attempt', as: 'gave-up' });
    add(w.moved, { kind: 'moved' });
    for (const v of VERDICTS) add(w.verdicts[v], { kind: 'applied', verdict: v });
  }
  return out;
}

const READ = readTable(Object.values(LEDGER_WORDS));

const pagesOf = (fourth: string) => (fourth === '-' || fourth === '' ? [] : fourth.split(', '));

/** null: an attempt-shaped line whose word no locale has, such as one a newer gateway wrote. */
function parseOutcome(third: string, fourth: string): LedgerOutcome | null {
  const word = READ.get(third);
  if (word?.kind === 'retry') return { kind: 'retry' };
  if (word?.kind === 'applied') return { kind: 'applied', verdict: word.verdict, pages: pagesOf(fourth) };
  const moved = MOVED.exec(third);
  if (moved && READ.get(moved[1]!)?.kind === 'moved') return { kind: 'moved', to: moved[2]! };
  const a = ATTEMPT.exec(third);
  if (a) {
    const m = READ.get(a[1]!);
    if (m?.kind !== 'attempt') return null;
    const attempt = Number(a[2]);
    const max = Number(a[3]);
    if (m.as === 'gave-up') return { kind: 'gave-up', attempt, max, reason: fourth };
    return { kind: 'attempt-failed', attempt, max, reason: fourth, interrupted: m.as === 'interrupted' };
  }
  return { kind: 'applied', verdict: { unknown: third }, pages: pagesOf(fourth) };
}

/** `${kind}:${id}` for a ledger line, null for any other line. */
export function lineKey(line: string): string | null {
  const m = LINE.exec(line.trimEnd());
  return m ? `${m[2]}:${m[3]}` : null;
}

type Raw = { readonly kind: string; readonly id: string; readonly outcome: LedgerOutcome | null };

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
    if (!outcome) return;
    if (outcome.kind === 'retry') {
      h = { attempts: 0, terminal: null, lastFailure: h.lastFailure };
      return;
    }
    // A move closes a job that gave up, so it overrides the give-up; an applied job is never moved.
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

/** The third field in the wiki's words. Commit subjects and _review.md notes reuse it. */
export function renderThird(locale: Locale, o: NewOutcome): string {
  const w = LEDGER_WORDS[locale];
  switch (o.kind) {
    case 'applied': return w.verdicts[o.verdict];
    case 'attempt-failed': return `${o.interrupted ? w.interrupted : w.failed} ${o.attempt}/${o.max}`;
    case 'gave-up': return `${w.gaveUp} ${o.attempt}/${o.max}`;
    case 'moved': return `${w.moved} → ${o.to.replaceAll('|', '/')}`;
    case 'retry': return w.retry;
  }
}

/** A verdict in the wiki's current words; text the gateway never wrote comes back as written. */
export const verdictText = (locale: Locale, v: Verdict): string => (typeof v === 'string' ? LEDGER_WORDS[locale].verdicts[v] : v.unknown);

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export function renderLine(locale: Locale, line: LedgerLine): string {
  const o = line.outcome;
  const fourth = o.kind === 'applied' ? (o.pages.length ? o.pages.join(', ') : '-') : o.kind === 'attempt-failed' || o.kind === 'gave-up' ? o.reason : '-';
  return `## [${line.date}] ${line.job} | ${line.id} | ${oneLine(renderThird(locale, o))} | ${oneLine(fourth) || '-'}`;
}

export function appendLine(locale: Locale, text: string, line: LedgerLine): string {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${renderLine(locale, line)}\n`;
}

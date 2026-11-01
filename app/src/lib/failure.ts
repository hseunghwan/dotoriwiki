import { copy } from '../text';
import type { MemoFailureWire, MemoStateWire } from './wire';

const SENTENCE: Partial<Record<string, string>> = copy.failure.sentence;

/** The name inside the first [[...]] of a broken-link detail, or null. */
export function brokenLinkTarget(detail: string): string | null {
  const m = /\[\[([^\]]+)\]\]/.exec(detail);
  return m ? m[1]! : null;
}

export type FailureSentence = { text: string; link: string | null };

/** `link` is the missing page name, shown highlighted inside the sentence. */
export function failureSentence(f: Pick<MemoFailureWire, 'code' | 'detail'>): FailureSentence {
  if (f.code === 'broken-link') {
    const link = brokenLinkTarget(f.detail);
    return link ? { text: copy.failure.brokenLink(link), link } : { text: copy.failure.brokenLinkUnnamed, link: null };
  }
  return { text: SENTENCE[f.code] ?? copy.failure.unknown, link: null };
}

/** The attempts suffix: on a failed memo after the sentence, on a retrying memo in its progress step. */
export function attemptsNote(state: MemoStateWire, f: MemoFailureWire | null): string | null {
  if (!f) return null;
  if (state === 'failed') return copy.failure.allBlocked(f.max);
  if (state === 'routed' || state === 'running') return copy.failure.retrying(f.attempts + 1);
  return null;
}

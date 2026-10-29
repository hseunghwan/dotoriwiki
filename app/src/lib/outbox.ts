/** expo-sqlite. The outbox is the only local state that matters: a memo is saved the moment it lands here. */
export type OutboxRow = {
  /** Client UUID, also the POST idempotency key. */
  id: string;
  /** MemoRequest JSON, frozen at capture. */
  body: string;
  created_at: string;
  attempts: number;
  state: 'queued' | 'dead';
  last_error: string | null;
};

export type Attempt =
  | { kind: 'sent' }
  | { kind: 'retry'; error: string }
  | { kind: 'unauthorized' }
  | { kind: 'rejected'; error: string };

export type HttpOutcome = { status: number; detail: string | null } | { network: string };

export function classify(outcome: HttpOutcome): Attempt {
  if ('network' in outcome) return { kind: 'retry', error: outcome.network };
  const { status, detail } = outcome;
  const error = detail ? `${status} ${detail}` : `HTTP ${status}`;
  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 408 || status === 429 || status >= 500) return { kind: 'retry', error };
  if (status >= 400) return { kind: 'rejected', error };
  // A 1xx or 3xx is not an answer about this memo, so keep it.
  return { kind: 'retry', error };
}

type RowEffect = 'delete' | 'keep' | 'dead';
/** `next` sends the following row, `backoff` ends the pass until a trigger or the retry timer, `pause` ends every pass until re-pairing. */
type PassEffect = 'next' | 'backoff' | 'pause';

export const TRANSITIONS: Record<Attempt['kind'], { row: RowEffect; pass: PassEffect }> = {
  sent: { row: 'delete', pass: 'next' },
  retry: { row: 'keep', pass: 'backoff' },
  unauthorized: { row: 'keep', pass: 'pause' },
  rejected: { row: 'dead', pass: 'next' },
};

export type OutboxStore = {
  /** Queued rows, oldest first. */
  queued(): Promise<OutboxRow[]>;
  remove(id: string): Promise<void>;
  /** attempts + 1, and the error if the attempt failed. */
  recordAttempt(id: string, error: string | null): Promise<void>;
  markDead(id: string, error: string): Promise<void>;
};

export type FlushResult = { kind: 'drained' } | { kind: 'backoff'; error: string } | { kind: 'paused' };

/** One pass over the queue. Every row is resent as-is, so a crash between POST and delete only produces a 200 duplicate later. */
export async function flushOnce(store: OutboxStore, send: (row: OutboxRow) => Promise<Attempt>): Promise<FlushResult> {
  for (const row of await store.queued()) {
    const attempt = await send(row);
    const t = TRANSITIONS[attempt.kind];
    const error = 'error' in attempt ? attempt.error : attempt.kind === 'unauthorized' ? '401 unauthorized' : null;
    if (t.row === 'delete') await store.remove(row.id);
    else if (t.row === 'dead') await store.markDead(row.id, error ?? 'rejected');
    else await store.recordAttempt(row.id, error);
    if (t.pass === 'backoff') return { kind: 'backoff', error: error ?? 'retry' };
    if (t.pass === 'pause') return { kind: 'paused' };
  }
  return { kind: 'drained' };
}

/** 5 s, 10 s, 20 s … capped at a minute: a phone waking from a dead zone should not wait long. */
export const backoffMs = (failures: number): number => Math.min(5_000 * 2 ** Math.max(0, failures - 1), 60_000);

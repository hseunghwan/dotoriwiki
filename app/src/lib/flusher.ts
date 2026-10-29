import { backoffMs, type FlushResult } from './outbox';

export type FlusherDeps = {
  pass: () => Promise<FlushResult>;
  /** Returns a cancel function. */
  setTimer: (ms: number, fire: () => void) => () => void;
  onResult: (r: FlushResult) => void;
};

export type Flusher = {
  /** Enqueue, foreground and network change all call this. Resolves when the queue is drained or the pass gave up. */
  trigger(): Promise<void>;
  /** After re-pairing: clear the 401 pause and flush. */
  resume(): Promise<void>;
  /** The retry timer only runs while the app is in the foreground. */
  setForeground(foreground: boolean): void;
};

/** One flush at a time. A trigger during a pass queues exactly one more pass, so a memo saved mid-flush is never stranded. */
export function createFlusher(deps: FlusherDeps): Flusher {
  let current: Promise<void> | null = null;
  let again = false;
  let paused = false;
  let failures = 0;
  let foreground = true;
  let cancelTimer: (() => void) | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  async function loop(): Promise<void> {
    for (;;) {
      again = false;
      let r: FlushResult;
      try {
        r = await deps.pass();
      } catch (e) {
        r = { kind: 'backoff', error: (e as Error).message };
      }
      if (r.kind === 'paused') paused = true;
      failures = r.kind === 'backoff' ? failures + 1 : 0;
      deps.onResult(r);
      if (r.kind === 'backoff' && !again && foreground) {
        cancelTimer = deps.setTimer(backoffMs(failures), () => {
          cancelTimer = null;
          void trigger();
        });
      }
      // Cleared in the same tick as the check, so a trigger that lands after it starts a new loop.
      if (!again || paused) {
        current = null;
        return;
      }
    }
  }

  function trigger(): Promise<void> {
    if (paused) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    clearTimer();
    current = loop();
    return current;
  }

  return {
    trigger,
    resume() {
      paused = false;
      failures = 0;
      return trigger();
    },
    setForeground(next) {
      foreground = next;
      if (next) void trigger();
      else clearTimer();
    },
  };
}

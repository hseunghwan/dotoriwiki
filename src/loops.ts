/**
 * When to call Wiki, never what it does. One router loop, one worker per domain so each
 * domain has exactly one writer while domains run in parallel, and a feed collector that only
 * ever calls wiki.accept. Wakes come from the filesystem
 * watcher, with a periodic rescan as the backstop, so a lost wake costs latency only. No job is
 * held in memory: every iteration asks Wiki, which asks the folder.
 *
 * Timing lives here: one process-wide LLM pause (any Unavailable sets it, and only jobs that
 * need no LLM run while it holds) and a per-domain exponential backoff after a failed attempt.
 */

import type { FeedReport } from './feeds.ts';
import { WikiConfigError, type DomainName, type RouteReport, type RunReport, type Wiki } from './wiki/index.ts';

export type Collector = {
  readonly poll: () => Promise<readonly FeedReport[]>;
  readonly firstMs: number;
  readonly everyMs: number;
};

export type LoopOptions = {
  readonly rescanMs: number;
  /** Wait after the first failed attempt; doubles with each further attempt. */
  readonly backoffMs: number;
  readonly collector: Collector | null;
  readonly onReport: (where: string, report: RouteReport | RunReport | FeedReport | { kind: 'error'; message: string }) => void;
};

/** A coalescing wake-up: notify() before wait() makes the next wait() return at once. */
export type Signal = { notify(): void; wait(timeoutMs: number): Promise<void> };

export function signal(): Signal {
  let pending = false;
  let waiter: (() => void) | null = null;
  return {
    notify() {
      if (waiter) waiter();
      else pending = true;
    },
    wait(timeoutMs) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((done) => {
        const timer = setTimeout(() => {
          waiter = null;
          done();
        }, Math.max(0, timeoutMs));
        waiter = () => {
          waiter = null;
          clearTimeout(timer);
          done();
        };
      });
    },
  };
}

export function startLoops(wiki: Wiki, opts: LoopOptions): { stop(): Promise<void> } {
  let stopped = false;
  let pausedUntil = 0;
  const pause = (ms: number) => (pausedUntil = Math.max(pausedUntil, Date.now() + ms));
  const router = signal();
  const workers = new Map<DomainName, Signal>();
  const running: Promise<void>[] = [];
  const fail = (where: string, e: unknown) => opts.onReport(where, { kind: 'error', message: (e as Error).stack ?? String(e) });

  /** Paused, there is nothing to spawn; the router reports why. */
  async function spawnMissingWorkers(): Promise<void> {
    const config = await wiki.config().catch((e: unknown) => {
      if (e instanceof WikiConfigError) return null;
      throw e;
    });
    for (const d of config?.domains.keys() ?? []) {
      if (workers.has(d) || stopped) continue;
      const wake = signal();
      workers.set(d, wake);
      running.push(domainWorker(d, wake));
    }
  }

  async function routerLoop(): Promise<void> {
    let pausedBy = '';
    while (!stopped) {
      if (Date.now() < pausedUntil) {
        await router.wait(pausedUntil - Date.now());
        continue;
      }
      let r: RouteReport;
      try {
        r = await wiki.routeNext();
      } catch (e) {
        fail('router', e);
        await router.wait(opts.backoffMs);
        continue;
      }
      const why = r.kind === 'paused' ? JSON.stringify(r.problems) : '';
      if (r.kind !== 'idle' && (r.kind !== 'paused' || why !== pausedBy)) opts.onReport('router', r);
      pausedBy = why;
      if (r.kind === 'idle' || r.kind === 'paused') {
        await router.wait(opts.rescanMs);
        await spawnMissingWorkers().catch((e) => fail('router', e));
      } else if (r.kind === 'unavailable') pause(r.retryAfterMs);
      else if (r.kind === 'routed') workers.get(r.domain)?.notify();
    }
  }

  async function domainWorker(d: DomainName, wake: Signal): Promise<void> {
    let backoffUntil = 0;
    while (!stopped) {
      const llmAt = Math.max(pausedUntil, backoffUntil);
      const withLlm = Date.now() >= llmAt;
      let r: RunReport;
      try {
        r = await wiki.runNext(d, { withLlm });
      } catch (e) {
        // A throw leaves the inflight marker; the next runNext recovers it like a crash.
        fail(`worker ${d}`, e);
        backoffUntil = Date.now() + opts.backoffMs;
        await wake.wait(opts.backoffMs);
        continue;
      }
      if (r.kind !== 'idle' && r.kind !== 'paused') opts.onReport(`worker ${d}`, r);
      if (r.kind === 'paused') await wake.wait(opts.rescanMs);
      else if (r.kind === 'idle') await wake.wait(withLlm ? opts.rescanMs : Math.min(opts.rescanMs, llmAt - Date.now()));
      else if (r.kind === 'unavailable') pause(r.retryAfterMs);
      else if (r.kind === 'retrying') backoffUntil = Date.now() + opts.backoffMs * 2 ** (r.attempt - 1);
      else backoffUntil = 0;
    }
  }

  const collectWake = signal();
  async function collectorLoop(c: Collector): Promise<void> {
    await collectWake.wait(c.firstMs);
    while (!stopped) {
      try {
        for (const r of await c.poll()) opts.onReport('collector', r);
      } catch (e) {
        fail('collector', e);
      }
      await collectWake.wait(c.everyMs);
    }
  }

  const unwatch = wiki.watch((w) => {
    if (w.kind === 'router') router.notify();
    else if (w.kind === 'domain') workers.get(w.domain)?.notify();
    else {
      router.notify();
      for (const worker of workers.values()) worker.notify();
      void spawnMissingWorkers().catch((e) => fail('watch', e));
    }
  });
  running.push(routerLoop());
  if (opts.collector) running.push(collectorLoop(opts.collector));
  void spawnMissingWorkers().catch((e) => fail('start', e));

  return {
    async stop() {
      stopped = true;
      unwatch();
      router.notify();
      collectWake.notify();
      for (const w of workers.values()) w.notify();
      await Promise.allSettled(running);
    },
  };
}

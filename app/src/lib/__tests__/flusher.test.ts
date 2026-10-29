import { createFlusher } from '../flusher';
import type { FlushResult } from '../outbox';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(results: (() => Promise<FlushResult>)[]) {
  let passes = 0;
  const timers: number[] = [];
  const fired: (() => void)[] = [];
  const flusher = createFlusher({
    pass: () => results[passes++]!(),
    setTimer: (ms, fire) => {
      timers.push(ms);
      fired.push(fire);
      return () => {};
    },
    onResult: () => {},
  });
  return { flusher, passes: () => passes, timers, fireTimer: () => fired.shift()!() };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const drained = async (): Promise<FlushResult> => ({ kind: 'drained' });
const backoff = async (): Promise<FlushResult> => ({ kind: 'backoff', error: 'offline' });
const paused = async (): Promise<FlushResult> => ({ kind: 'paused' });

it('runs one flush at a time and folds triggers during a pass into one more pass', async () => {
  const first = deferred<FlushResult>();
  const h = harness([() => first.promise, drained, drained]);

  const a = h.flusher.trigger();
  const b = h.flusher.trigger();
  const c = h.flusher.trigger();
  expect(h.passes()).toBe(1);

  first.resolve({ kind: 'drained' });
  await Promise.all([a, b, c]);
  expect(h.passes()).toBe(2);
});

it('starts a fresh pass for a trigger after the previous one finished', async () => {
  const h = harness([drained, drained]);
  await h.flusher.trigger();
  await h.flusher.trigger();
  expect(h.passes()).toBe(2);
});

it('retries on a timer with growing backoff while the gateway is unreachable', async () => {
  const h = harness([backoff, backoff, drained]);
  await h.flusher.trigger();
  expect(h.timers).toEqual([5_000]);

  h.fireTimer();
  await settle();
  expect(h.timers).toEqual([5_000, 10_000]);

  h.fireTimer();
  await settle();
  expect(h.passes()).toBe(3);
  expect(h.timers).toEqual([5_000, 10_000]);
});

it('stops flushing after a 401 until resumed', async () => {
  const h = harness([paused, drained]);
  await h.flusher.trigger();
  await h.flusher.trigger();
  expect(h.passes()).toBe(1);

  await h.flusher.resume();
  expect(h.passes()).toBe(2);
});

it('does not arm the retry timer in the background', async () => {
  const h = harness([backoff, drained]);
  h.flusher.setForeground(false);
  await h.flusher.trigger();
  expect(h.timers).toEqual([]);
});

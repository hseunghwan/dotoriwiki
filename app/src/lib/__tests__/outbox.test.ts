import { classify, flushOnce, type Attempt, type OutboxRow, type OutboxStore } from '../outbox';

function memoryStore(rows: OutboxRow[]): OutboxStore & { rows: OutboxRow[] } {
  const store = {
    rows,
    async queued() {
      return store.rows.filter((r) => r.state === 'queued');
    },
    async remove(id: string) {
      store.rows = store.rows.filter((r) => r.id !== id);
    },
    async recordAttempt(id: string, error: string | null) {
      store.rows = store.rows.map((r) => (r.id === id ? { ...r, attempts: r.attempts + 1, last_error: error } : r));
    },
    async markDead(id: string, error: string) {
      store.rows = store.rows.map((r) => (r.id === id ? { ...r, attempts: r.attempts + 1, state: 'dead' as const, last_error: error } : r));
    },
  };
  return store;
}

const row = (id: string): OutboxRow => ({ id, body: `{"id":"${id}"}`, created_at: '2026-10-29T00:00:00Z', attempts: 0, state: 'queued', last_error: null });

function sender(outcomes: Record<string, Attempt>) {
  const sent: string[] = [];
  return { sent, send: async (r: OutboxRow) => (sent.push(r.id), outcomes[r.id]!) };
}

describe('classify', () => {
  it.each([
    [{ status: 201, detail: null }, 'sent'],
    [{ status: 200, detail: null }, 'sent'],
    [{ status: 401, detail: null }, 'unauthorized'],
    [{ status: 408, detail: null }, 'retry'],
    [{ status: 429, detail: null }, 'retry'],
    [{ status: 500, detail: 'internal' }, 'retry'],
    [{ status: 503, detail: null }, 'retry'],
    [{ network: 'Network request failed' }, 'retry'],
    [{ network: 'timeout' }, 'retry'],
    [{ status: 400, detail: 'text: required' }, 'rejected'],
    [{ status: 404, detail: null }, 'rejected'],
    [{ status: 413, detail: 'body over 262144 bytes' }, 'rejected'],
  ] as const)('%j is %s', (outcome, kind) => {
    expect(classify(outcome).kind).toBe(kind);
  });

  it('keeps the gateway detail in the error a dead row shows', () => {
    expect(classify({ status: 400, detail: 'text: required' })).toEqual({ kind: 'rejected', error: '400 text: required' });
  });
});

describe('flushOnce', () => {
  it('removes sent rows, marks rejected rows dead, and keeps going', async () => {
    const store = memoryStore([row('a'), row('b'), row('c')]);
    const { send, sent } = sender({ a: { kind: 'sent' }, b: { kind: 'rejected', error: '400 text: required' }, c: { kind: 'sent' } });

    expect(await flushOnce(store, send)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(store.rows).toEqual([{ ...row('b'), attempts: 1, state: 'dead', last_error: '400 text: required' }]);
  });

  it('stops at a retryable failure and keeps that row queued with the error', async () => {
    const store = memoryStore([row('a'), row('b'), row('c')]);
    const { send, sent } = sender({ a: { kind: 'sent' }, b: { kind: 'retry', error: 'HTTP 503' }, c: { kind: 'sent' } });

    expect(await flushOnce(store, send)).toEqual({ kind: 'backoff', error: 'HTTP 503' });
    expect(sent).toEqual(['a', 'b']);
    expect(store.rows).toEqual([{ ...row('b'), attempts: 1, last_error: 'HTTP 503' }, row('c')]);
  });

  it('pauses on 401 without losing the row', async () => {
    const store = memoryStore([row('a'), row('b')]);
    const { send, sent } = sender({ a: { kind: 'unauthorized' }, b: { kind: 'sent' } });

    expect(await flushOnce(store, send)).toEqual({ kind: 'paused' });
    expect(sent).toEqual(['a']);
    expect(store.rows.map((r) => [r.id, r.state])).toEqual([['a', 'queued'], ['b', 'queued']]);
  });

  it('never resends dead rows', async () => {
    const store = memoryStore([{ ...row('a'), state: 'dead', last_error: '400 x' }]);
    const { send, sent } = sender({});
    expect(await flushOnce(store, send)).toEqual({ kind: 'drained' });
    expect(sent).toEqual([]);
  });
});

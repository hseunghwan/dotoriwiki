import { classify, flushOnce, type Attempt, type OutboxFile, type OutboxRow, type OutboxStore } from '../outbox';

function memoryStore(rows: OutboxRow[], files: OutboxFile[] = []): OutboxStore & { rows: OutboxRow[]; files_: OutboxFile[] } {
  const store = {
    rows,
    files_: files,
    async queued() {
      return store.rows.filter((r) => r.state === 'queued');
    },
    async files(id: string) {
      return store.files_.filter((f) => f.memo_id === id).sort((a, b) => a.n - b.n);
    },
    async markUploaded(id: string, n: number) {
      store.files_ = store.files_.map((f) => (f.memo_id === id && f.n === n ? { ...f, uploaded: 1 } : f));
    },
    async remove(id: string) {
      store.rows = store.rows.filter((r) => r.id !== id);
      store.files_ = store.files_.filter((f) => f.memo_id !== id);
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

const file = (memo_id: string, n: number, uploaded = 0): OutboxFile => ({ memo_id, n, path: `file:///files/outbox/${memo_id}-${n}.jpg`, uploaded });

/** One log for uploads and posts, so a test can see their order: "a/1" is a PUT, "a" the POST. */
function sender(outcomes: Record<string, Attempt | Attempt[]>) {
  const sent: string[] = [];
  const next = (key: string): Attempt => {
    const o = outcomes[key] ?? { kind: 'sent' };
    return Array.isArray(o) ? (o.shift() ?? { kind: 'sent' }) : o;
  };
  return {
    sent,
    send: async (r: OutboxRow) => (sent.push(r.id), next(r.id)),
    upload: async (r: OutboxRow, f: OutboxFile) => (sent.push(`${r.id}/${f.n}`), next(`${r.id}/${f.n}`)),
  };
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
    const { send, upload, sent } = sender({ a: { kind: 'sent' }, b: { kind: 'rejected', error: '400 text: required' }, c: { kind: 'sent' } });

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(store.rows).toEqual([{ ...row('b'), attempts: 1, state: 'dead', last_error: '400 text: required' }]);
  });

  it('stops at a retryable failure and keeps that row queued with the error', async () => {
    const store = memoryStore([row('a'), row('b'), row('c')]);
    const { send, upload, sent } = sender({ a: { kind: 'sent' }, b: { kind: 'retry', error: 'HTTP 503' }, c: { kind: 'sent' } });

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'backoff', error: 'HTTP 503' });
    expect(sent).toEqual(['a', 'b']);
    expect(store.rows).toEqual([{ ...row('b'), attempts: 1, last_error: 'HTTP 503' }, row('c')]);
  });

  it('pauses on 401 without losing the row', async () => {
    const store = memoryStore([row('a'), row('b')]);
    const { send, upload, sent } = sender({ a: { kind: 'unauthorized' }, b: { kind: 'sent' } });

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'paused' });
    expect(sent).toEqual(['a']);
    expect(store.rows.map((r) => [r.id, r.state])).toEqual([['a', 'queued'], ['b', 'queued']]);
  });

  it('never resends dead rows', async () => {
    const store = memoryStore([{ ...row('a'), state: 'dead', last_error: '400 x' }]);
    const { send, upload, sent } = sender({});
    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual([]);
  });

  it('uploads every photo before posting the memo, then drops the files with the row', async () => {
    const store = memoryStore([row('a'), row('b')], [file('a', 2), file('a', 1)]);
    const { send, upload, sent } = sender({});

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a/1', 'a/2', 'a', 'b']);
    expect(store.rows).toEqual([]);
    expect(store.files_).toEqual([]);
  });

  it('backs off on a retryable upload, keeps what got up, and resends only the rest', async () => {
    const store = memoryStore([row('a'), row('b')], [file('a', 1), file('a', 2)]);
    const { send, upload, sent } = sender({ 'a/2': [{ kind: 'retry', error: 'HTTP 503' }] });

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'backoff', error: '사진 2: HTTP 503' });
    expect(sent).toEqual(['a/1', 'a/2']);
    expect(store.rows[0]).toEqual({ ...row('a'), attempts: 1, last_error: '사진 2: HTTP 503' });
    expect(store.files_.map((f) => [f.n, f.uploaded])).toEqual([[1, 1], [2, 0]]);

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a/1', 'a/2', 'a/2', 'a', 'b']);
  });

  it('never resends a photo already uploaded', async () => {
    const store = memoryStore([row('a')], [file('a', 1, 1), file('a', 2)]);
    const { send, upload, sent } = sender({});

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a/2', 'a']);
  });

  it('marks the row dead on an upload 4xx without posting it, and moves on', async () => {
    const store = memoryStore([row('a'), row('b')], [file('a', 1)]);
    const outcome = classify({ status: 400, detail: 'not an image' });
    const { send, upload, sent } = sender({ 'a/1': outcome });

    expect(outcome.kind).toBe('rejected');
    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'drained' });
    expect(sent).toEqual(['a/1', 'b']);
    expect(store.rows).toEqual([{ ...row('a'), attempts: 1, state: 'dead', last_error: '사진 1: 400 not an image' }]);
  });

  it('pauses on an upload 401 and keeps the row queued', async () => {
    const store = memoryStore([row('a'), row('b')], [file('a', 1)]);
    const { send, upload, sent } = sender({ 'a/1': { kind: 'unauthorized' } });

    expect(await flushOnce(store, send, upload)).toEqual({ kind: 'paused' });
    expect(sent).toEqual(['a/1']);
    expect(store.rows.map((r) => [r.id, r.state, r.last_error])).toEqual([['a', 'queued', '401 unauthorized'], ['b', 'queued', null]]);
  });
});

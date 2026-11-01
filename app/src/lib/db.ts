import * as SQLite from 'expo-sqlite';
import { removeQuietly } from './files';
import type { OutboxFile, OutboxRow, OutboxStore } from './outbox';

let opened: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  opened ??= (async () => {
    // The name predates dotoriwiki. Renaming it would strand the outbox of a phone that upgrades.
    const d = await SQLite.openDatabaseAsync('llmwiki.db');
    await d.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'dead')),
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox_files (
        memo_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        path TEXT NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (memo_id, n)
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    return d;
  })();
  return opened;
}

/** The row and its file rows in one transaction, then the files themselves. */
async function removeRow(id: string): Promise<void> {
  const d = await db();
  const files = await d.getAllAsync<{ path: string }>('SELECT path FROM outbox_files WHERE memo_id = ?', id);
  await d.withTransactionAsync(async () => {
    await d.runAsync('DELETE FROM outbox_files WHERE memo_id = ?', id);
    await d.runAsync('DELETE FROM outbox WHERE id = ?', id);
  });
  removeQuietly(files.map((f) => f.path));
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export const outbox = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** INSERT OR IGNORE: enqueueing the same capture twice keeps one row. The photo files must already be in place. */
  async enqueue(id: string, body: string, createdAt: string, files: readonly { n: number; path: string }[] = []): Promise<void> {
    const d = await db();
    await d.withTransactionAsync(async () => {
      await d.runAsync('INSERT OR IGNORE INTO outbox (id, body, created_at) VALUES (?, ?, ?)', id, body, createdAt);
      for (const f of files) await d.runAsync('INSERT OR IGNORE INTO outbox_files (memo_id, n, path) VALUES (?, ?, ?)', id, f.n, f.path);
    });
    changed();
  },

  async all(): Promise<OutboxRow[]> {
    return (await db()).getAllAsync<OutboxRow>('SELECT * FROM outbox ORDER BY created_at, id');
  },

  /** Every row's photos, for the thumbnails on rows not yet sent. */
  async allFiles(): Promise<OutboxFile[]> {
    return (await db()).getAllAsync<OutboxFile>('SELECT * FROM outbox_files ORDER BY memo_id, n');
  },

  async requeue(id: string): Promise<void> {
    await (await db()).runAsync("UPDATE outbox SET state = 'queued', last_error = NULL WHERE id = ?", id);
    changed();
  },

  async discard(id: string): Promise<void> {
    await removeRow(id);
    changed();
  },

  store: {
    async queued() {
      return (await db()).getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE state = 'queued' ORDER BY created_at, id");
    },
    async files(id) {
      return (await db()).getAllAsync<OutboxFile>('SELECT * FROM outbox_files WHERE memo_id = ? ORDER BY n', id);
    },
    async markUploaded(id, n) {
      await (await db()).runAsync('UPDATE outbox_files SET uploaded = 1 WHERE memo_id = ? AND n = ?', id, n);
    },
    async remove(id) {
      await removeRow(id);
      changed();
    },
    async recordAttempt(id, error) {
      await (await db()).runAsync('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', error, id);
      changed();
    },
    async markDead(id, error) {
      await (await db()).runAsync("UPDATE outbox SET attempts = attempts + 1, state = 'dead', last_error = ? WHERE id = ?", error, id);
      changed();
    },
  } satisfies OutboxStore,
};

export const kv = {
  async get(key: string): Promise<string | null> {
    return (await (await db()).getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key))?.value ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    await (await db()).runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  },
};

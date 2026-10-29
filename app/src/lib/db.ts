import * as SQLite from 'expo-sqlite';
import type { OutboxRow, OutboxStore } from './outbox';

let opened: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  opened ??= (async () => {
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
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    return d;
  })();
  return opened;
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export const outbox = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** INSERT OR IGNORE: enqueueing the same capture twice keeps one row. */
  async enqueue(id: string, body: string, createdAt: string): Promise<void> {
    await (await db()).runAsync('INSERT OR IGNORE INTO outbox (id, body, created_at) VALUES (?, ?, ?)', id, body, createdAt);
    changed();
  },

  async all(): Promise<OutboxRow[]> {
    return (await db()).getAllAsync<OutboxRow>('SELECT * FROM outbox ORDER BY created_at, id');
  },

  async requeue(id: string): Promise<void> {
    await (await db()).runAsync("UPDATE outbox SET state = 'queued', last_error = NULL WHERE id = ?", id);
    changed();
  },

  async discard(id: string): Promise<void> {
    await (await db()).runAsync('DELETE FROM outbox WHERE id = ?', id);
    changed();
  },

  store: {
    async queued() {
      return (await db()).getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE state = 'queued' ORDER BY created_at, id");
    },
    async remove(id) {
      await (await db()).runAsync('DELETE FROM outbox WHERE id = ?', id);
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

import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { buildMemoRequest, type CaptureInput } from './lib/capture';
import { kv, outbox } from './lib/db';
import { adopt, sweepPending } from './lib/files';
import { createFlusher } from './lib/flusher';
import { gateway, observeGateway } from './lib/gateway';
import { flushOnce } from './lib/outbox';
import { parseStoredPairing, type Pairing } from './lib/pairing';
import { attachmentsOf, type DraftPhoto } from './lib/photos';
import type { StatusResponse } from './lib/wire';

export type ThemePref = 'system' | 'dark' | 'light';
export type Settings = { location: boolean; theme: ThemePref };

export type App = {
  ready: boolean;
  pairing: Pairing | null;
  /** Domain folder names from the last GET /status, cached so the chips work offline. */
  domains: string[];
  /** null until the first call answers or fails. */
  reachable: boolean | null;
  /** A 401 paused the outbox; the user has to pair again. */
  authLost: boolean;
  settings: Settings;
};

let app: App = { ready: false, pairing: null, domains: [], reachable: null, authLost: false, settings: { location: false, theme: 'system' } };
const listeners = new Set<() => void>();

function set(patch: Partial<App>): void {
  app = { ...app, ...patch };
  listeners.forEach((l) => l());
}

export function useApp<T>(select: (a: App) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(app),
  );
}

export const getApp = (): App => app;

const flusher = createFlusher({
  pass: async () => {
    const p = app.pairing;
    if (!p || app.authLost) return { kind: 'paused' };
    return flushOnce(
      outbox.store,
      (row) => gateway.postMemo(p, row.body),
      (_row, file) => gateway.putAttachment(p, file),
    );
  },
  setTimer: (ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
  onResult: () => {},
});

export const flushNow = (): Promise<void> => flusher.trigger();

/** Saves the memo to the outbox first; the returned promise is only the send attempt. */
export async function capture(input: Omit<CaptureInput, 'id' | 'at' | 'attachments'> & { photos?: readonly DraftPhoto[] }): Promise<{ id: string; sent: Promise<void> }> {
  const id = Crypto.randomUUID();
  const at = new Date();
  const { photos = [], ...rest } = input;
  const files: { n: number; path: string }[] = [];
  for (const [i, photo] of photos.entries()) files.push({ n: i + 1, path: await adopt(photo.uri, id, i + 1) });
  const body = buildMemoRequest({ ...rest, id, at, attachments: attachmentsOf(photos) });
  await outbox.enqueue(id, JSON.stringify(body), at.toISOString(), files);
  return { id, sent: flusher.trigger() };
}

export async function pair(pairing: Pairing, status: StatusResponse): Promise<void> {
  await SecureStore.setItemAsync('pairing', JSON.stringify(pairing));
  await rememberDomains(status);
  set({ pairing, authLost: false, reachable: true });
  void flusher.resume();
}

async function rememberDomains(status: StatusResponse): Promise<void> {
  const domains = Object.keys(status.domains);
  set({ domains });
  await kv.set('domains', JSON.stringify(domains));
}

export async function refreshStatus(): Promise<StatusResponse | null> {
  const p = app.pairing;
  if (!p) return null;
  const r = await gateway.status(p);
  if (!r.ok) return null;
  await rememberDomains(r.data);
  return r.data;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...app.settings, ...patch };
  set({ settings });
  await kv.set('settings', JSON.stringify(settings));
}

function parseDomains(text: string | null): string[] {
  try {
    const v: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function parseSettings(text: string | null): Settings {
  try {
    const v = text ? (JSON.parse(text) as Partial<Settings>) : {};
    return {
      location: typeof v.location === 'boolean' ? v.location : app.settings.location,
      theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'system',
    };
  } catch {
    return app.settings;
  }
}

let booted: Promise<void> | null = null;

export function boot(): Promise<void> {
  booted ??= (async () => {
    observeGateway({
      unauthorized: () => set({ authLost: true }),
      reachability: (reachable) => {
        if (reachable !== app.reachable) set({ reachable });
      },
    });
    const [pairing, domains, settings] = await Promise.all([
      SecureStore.getItemAsync('pairing').then(parseStoredPairing),
      kv.get('domains').then(parseDomains),
      kv.get('settings').then(parseSettings),
    ]);
    set({ ready: true, pairing, domains, settings });
    sweepPending();

    AppState.addEventListener('change', (s) => flusher.setForeground(s === 'active'));
    Network.addNetworkStateListener((e) => {
      if (e.isConnected) void flusher.trigger();
    });
    void flusher.trigger();
    if (pairing) void refreshStatus();
  })();
  return booted;
}

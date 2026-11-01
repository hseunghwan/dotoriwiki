import { copy } from '../text';
import type { PairingPayload } from './wire';

/** Stored in expo-secure-store once GET /status confirms it. */
export type Pairing = { url: string; token: string; server: string };

export type PairingMode = 'qr' | 'manual';

/** A url and token the user offered, not yet confirmed by GET /status. */
export type Candidate = { mode: PairingMode; url: string; token: string };

export type PairingFailure = 'invalid' | 'unreachable' | 'unauthorized' | 'unexpected';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ORIGIN = /^(https?):\/\/([^/\s?#]+)(\/[^\s?#]*)?$/i;

/** `macmini.tail-xxxx.ts.net:8787` → `http://macmini.tail-xxxx.ts.net:8787`. The gateway speaks plain HTTP over Tailscale. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const m = ORIGIN.exec(withScheme.replace(/\/+$/, ''));
  if (!m) return null;
  return `${m[1]!.toLowerCase()}://${m[2]}${m[3] ?? ''}`;
}

/** The QR that `npm run pair` prints: PairingPayload JSON with v 1. */
export function parseQr(text: string): Candidate | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.v !== 1) return null;
  const { url, token, server } = data as Partial<Record<keyof PairingPayload, unknown>>;
  if (typeof url !== 'string' || typeof token !== 'string' || token.trim() === '' || typeof server !== 'string') return null;
  const normalized = normalizeUrl(url);
  return normalized ? { mode: 'qr', url: normalized, token: token.trim() } : null;
}

export function parseManual(url: string, token: string): Candidate | null {
  const normalized = normalizeUrl(url);
  return normalized && token.trim() !== '' ? { mode: 'manual', url: normalized, token: token.trim() } : null;
}

/** Stored pairings are external data too: a bad one reads as "not paired". */
export function parseStoredPairing(json: string | null): Pairing | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v) || typeof v.url !== 'string' || typeof v.token !== 'string' || typeof v.server !== 'string') return null;
    return { url: v.url, token: v.token, server: v.server };
  } catch {
    return null;
  }
}

export const pairingFailureCopy = (mode: PairingMode, failure: PairingFailure): string => copy.pairing[mode][failure];

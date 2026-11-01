import { useSyncExternalStore } from 'react';
import { gateway, type Failure } from './lib/gateway';
import { copy } from './text';
import { getApp } from './state';

/** A move waits for the target domain's lane on the gateway, so it outlives the sheet that started it. */
export type Move = { to: string; status: 'moving' } | { to: string; status: 'moved' } | { to: string; status: 'failed'; message: string };

const moves = new Map<string, Move>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function failureMessage(f: Failure): string {
  if (f.kind === 'http' && f.status === 409) return f.detail === 'ingested' || f.detail === 'running' ? copy.move.started : copy.move.wrongState;
  if (f.kind === 'http' && f.status === 404) return copy.common.notFound;
  if (f.kind === 'http' && f.status === 400) return copy.move.unknownDomain;
  if (f.kind === 'unreachable') return copy.move.unreachable;
  return copy.move.failed;
}

export async function startMove(id: string, to: string): Promise<Move> {
  const pairing = getApp().pairing;
  if (!pairing) return { to, status: 'failed', message: copy.move.notPaired };
  moves.set(id, { to, status: 'moving' });
  emit();
  const r = await gateway.move(pairing, id, to);
  const done: Move = r.ok ? { to: r.data.domain, status: 'moved' } : { to, status: 'failed', message: failureMessage(r.failure) };
  moves.set(id, done);
  emit();
  return done;
}

export function useMove(id: string): Move | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => moves.get(id) ?? null,
  );
}

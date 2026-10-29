import { useSyncExternalStore } from 'react';
import { gateway, type Failure } from './lib/gateway';
import { getApp } from './state';

/** A move waits for the target domain's lane on the Mac, so it outlives the sheet that started it. */
export type Move = { to: string; status: 'moving' } | { to: string; status: 'moved' } | { to: string; status: 'failed'; message: string };

const moves = new Map<string, Move>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function failureMessage(f: Failure): string {
  if (f.kind === 'http' && f.status === 409) return f.detail === 'ingested' || f.detail === 'running' ? '이미 정리가 시작돼서 옮길 수 없어요.' : '지금 상태에서는 옮길 수 없어요.';
  if (f.kind === 'http' && f.status === 404) return '맥미니에서 이 메모를 찾지 못했어요.';
  if (f.kind === 'http' && f.status === 400) return '맥미니에 없는 도메인이에요.';
  if (f.kind === 'unreachable') return '맥미니에 연결하지 못했어요. 연결되면 다시 옮겨 주세요.';
  return '옮기지 못했어요.';
}

export async function startMove(id: string, to: string): Promise<Move> {
  const pairing = getApp().pairing;
  if (!pairing) return { to, status: 'failed', message: '맥미니와 연결되어 있지 않아요.' };
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

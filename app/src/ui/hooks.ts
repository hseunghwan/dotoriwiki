import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { outbox } from '../lib/db';
import type { OutboxFile, OutboxRow } from '../lib/outbox';

export function useOutbox(): OutboxRow[] {
  const [rows, setRows] = useState<OutboxRow[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void outbox.all().then((r) => live && setRows(r));
    load();
    const off = outbox.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return rows;
}

/** The outbox's photo files, refreshed with the rows. */
export function useOutboxFiles(): OutboxFile[] {
  const [files, setFiles] = useState<OutboxFile[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void outbox.allFiles().then((f) => live && setFiles(f));
    load();
    const off = outbox.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return files;
}

export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * Runs `load` when the screen gains focus, and again every `everyMs` while it keeps focus, the app is
 * in the foreground, and `active` holds. `active` is how a screen stops polling once nothing is moving.
 */
export function useFocusPoll(load: () => Promise<unknown>, everyMs: number, active: boolean): void {
  const loadRef = useRef(load);
  loadRef.current = load;
  const activeRef = useRef(active);
  activeRef.current = active;

  useFocusEffect(
    useCallback(() => {
      void loadRef.current();
      const tick = setInterval(() => {
        if (activeRef.current && AppState.currentState === 'active') void loadRef.current();
      }, everyMs);
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') void loadRef.current();
      });
      return () => {
        clearInterval(tick);
        sub.remove();
      };
    }, [everyMs]),
  );
}

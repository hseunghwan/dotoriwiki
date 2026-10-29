/**
 * One model CLI process that prints JSON lines: spawned without a shell, prompt on stdin,
 * killed on timeout or shutdown. Shared by the claude and codex adapters.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Finished = {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly stderr: string;
  readonly events: readonly Json[];
};

export type RunOptions = { readonly timeoutMs?: number; readonly onEvent?: (e: Json) => void };

export type CliRunner = {
  run(argv: readonly string[], cwd: string, stdin: string, opts?: RunOptions): Promise<Finished>;
  /** A child that stopAll also kills; the caller reads its streams. */
  spawn(argv: readonly string[], cwd: string): ChildProcessWithoutNullStreams;
  stopAll(): void;
};

export function cliRunner(bin: string, env: () => NodeJS.ProcessEnv): CliRunner {
  const live = new Set<ChildProcessWithoutNullStreams>();

  function track(argv: readonly string[], cwd: string): ChildProcessWithoutNullStreams {
    const child = spawn(bin, argv, { cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    live.add(child);
    child.on('close', () => live.delete(child));
    return child;
  }

  return {
    spawn: track,

    run(argv, cwd, stdin, opts = {}) {
      return new Promise((resolveRun) => {
        const events: Json[] = [];
        let stderr = '';
        let spawnError: string | null = null;
        let timedOut = false;
        const child = track(argv, cwd);
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
            }, opts.timeoutMs)
          : null;
        child.on('error', (e) => (spawnError = e.message));
        child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
        createInterface({ input: child.stdout }).on('line', (line) => {
          let e: unknown;
          try {
            e = JSON.parse(line);
          } catch {
            return;
          }
          if (!isObj(e)) return;
          events.push(e);
          opts.onEvent?.(e);
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolveRun({ code, timedOut, spawnError, stderr, events });
        });
      });
    },

    stopAll() {
      for (const c of live) c.kill('SIGTERM');
    },
  };
}

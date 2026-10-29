/**
 * Thin git shell over execFile. Argv arrays, so "미루기 아카이빙" needs no quoting; `-z` output,
 * so no quotepath escaping; `--literal-pathspecs`, so a page named "C++ [메모].md" matches only
 * itself. Private to src/wiki/.
 *
 * All calls share one in-process mutex. Domains run in parallel, but .git/index is one
 * resource, and each critical section takes milliseconds while LLM runs take minutes.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Change } from './pages.ts';

export type Git = {
  head(): Promise<string | null>;
  /** File content at rev, or null when the path does not exist there. */
  show(rev: string, path: string): Promise<string | null>;
  lsTree(rev: string, paths: readonly string[]): Promise<readonly string[]>;
  status(paths: readonly string[]): Promise<readonly Change[]>;
  /** Every line each commit up to rev added to these files, oldest commit first. One git call. */
  appended(rev: string, paths: readonly string[]): Promise<readonly AppendedLine[]>;
  /** The files under paths that one commit added, modified, or deleted; a rename is a delete and an add. */
  changed(sha: string, paths: readonly string[]): Promise<readonly Change[]>;
  /** Puts each path back to its HEAD state; a path absent at HEAD is removed from index and disk. */
  resetPaths(paths: readonly string[]): Promise<void>;
  /** Stages and commits exactly these paths, leaving anything else staged untouched. Returns the sha. */
  commit(paths: readonly string[], message: string): Promise<string>;
  /** Removes .git/index.lock. Only safe while holding the gateway lock, when no git of ours can be running. */
  clearIndexLock(): Promise<void>;
};

export type AppendedLine = { readonly sha: string; readonly committedAt: string; readonly path: string; readonly line: string };

type Committer = { readonly name: string; readonly email: string };

export function openGit(root: string, committer: Committer): Git {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const raw = (args: readonly string[], okCodes: readonly number[] = [0]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res, rej) => {
      execFile(
        'git',
        ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'core.precomposeunicode=true', ...args],
        { cwd: root, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
          if (okCodes.includes(code)) res({ code, stdout, stderr });
          else rej(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
        },
      );
    });
  const run = async (args: readonly string[]) => (await raw(args)).stdout;
  const z = (out: string) => out.split('\0').filter((s) => s !== '').map((s) => s.normalize('NFC'));

  const head = async () => {
    const r = await raw(['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const lsTree = async (rev: string, paths: readonly string[]) =>
    paths.length === 0 ? [] : z(await run(['ls-tree', '-r', '--name-only', '-z', rev, '--', ...paths]));

  return {
    head: () => serial(head),
    show: (rev, path) =>
      serial(async () => {
        const r = await raw(['show', `${rev}:${path}`], [0, 128]);
        return r.code === 0 ? r.stdout : null;
      }),
    lsTree: (rev, paths) => serial(() => lsTree(rev, paths)),
    status: (paths) =>
      serial(async () => {
        const entries = z(await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]));
        const out: Change[] = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const xy = e.slice(0, 2);
          if (xy[0] === 'R' || xy[0] === 'C') i++;
          const status = xy === '??' ? 'untracked' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : 'modified';
          out.push({ path: e.slice(3), status });
        }
        return out;
      }),
    appended: (rev, paths) =>
      serial(async () => {
        if (paths.length === 0) return [];
        const out: AppendedLine[] = [];
        let commit: { sha: string; committedAt: string } | null = null;
        let path: string | null = null;
        let inHunk = false;
        const log = await run(['log', '--reverse', '--no-renames', '--no-color', '--no-ext-diff', '--unified=0', '--format=%x00%H %cI', '-p', rev, '--', ...paths]);
        for (const line of log.split('\n')) {
          if (line.startsWith('\0')) {
            const [sha, committedAt] = line.slice(1).split(' ');
            commit = { sha: sha!, committedAt: committedAt! };
            inHunk = false;
          } else if (line.startsWith('diff --git ')) inHunk = false;
          else if (line.startsWith('@@')) inHunk = true;
          // A path with a space ends in a tab on the +++ line.
          else if (!inHunk && line.startsWith('+++ ')) path = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length).replace(/\t$/, '').normalize('NFC');
          else if (inHunk && line.startsWith('+') && commit && path) out.push({ ...commit, path, line: line.slice(1) });
        }
        return out;
      }),
    changed: (sha, paths) =>
      serial(async () => {
        const entries = z(await run(['show', '--no-renames', '--no-color', '--format=', '--name-status', '-z', sha, '--', ...paths]));
        const out: Change[] = [];
        for (let i = 0; i + 1 < entries.length; i += 2) {
          const s = entries[i]!;
          out.push({ path: entries[i + 1]!, status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified' });
        }
        return out;
      }),
    resetPaths: (paths) =>
      serial(async () => {
        if (paths.length === 0) return;
        const atHead = new Set((await head()) ? await lsTree('HEAD', paths) : []);
        const gone = paths.filter((p) => !atHead.has(p));
        if (atHead.size) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...atHead]);
        if (gone.length) await run(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...gone]);
        for (const p of gone) await fs.rm(join(root, ...p.split('/')), { force: true });
      }),
    commit: (paths, message) =>
      serial(async () => {
        await run(['add', '-A', '--', ...paths]);
        await run([
          '-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, '-c', 'commit.gpgsign=false',
          'commit', '--no-verify', '-q', '--only', '-m', message, '--', ...paths,
        ]);
        return (await head())!;
      }),
    clearIndexLock: () =>
      serial(async () => {
        const lock = (await run(['rev-parse', '--git-path', 'index.lock'])).trim();
        await fs.rm(resolve(root, lock), { force: true });
      }),
  };
}

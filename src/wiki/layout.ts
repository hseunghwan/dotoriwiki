/**
 * Where things are in the wiki folder, plus the few filesystem primitives that make each
 * transition atomic. This is the only file that knows a path shape.
 *
 * Every path that crosses this boundary is NFC-normalized. APFS looks names up
 * normalization-insensitively, but git (core.precomposeUnicode) reports NFC, and the domain
 * names are Korean, so readdir output and git output are compared only after normalizing.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { DomainName, JobRef } from './index.ts';

const nfc = (s: string) => s.normalize('NFC');

export type Layout = {
  readonly root: string;
  readonly inboxDir: string;
  readonly rejectedDir: string;
  answersInboxDir(d: DomainName): string;
  domainDir(d: DomainName): string;
  rawDir(d: DomainName): string;
  holdDir(d: DomainName): string;
  wikiDir(d: DomainName): string;
  inflightFile(d: DomainName): string;
  readonly lockFile: string;
  readonly rootSchema: string;
  readonly commonRules: string;
  /** Repo-relative paths, as git prints them. */
  wikiRel(d: DomainName): string;
  logRel(d: DomainName): string;
  indexRel(d: DomainName): string;
  reviewRel(d: DomainName): string;
  rawRel(d: DomainName, name: string): string;
  /** Absolute path → repo-relative NFC path, or null when it is outside the root. */
  toRel(absPath: string): string | null;
  fromRel(rel: string): string;
  /** Repo-relative path → which loop a change there should wake, or null. */
  wakeFor(rel: string): RawWake | null;
};

/** A wake whose domain segment has not been checked against the domain list yet. */
export type RawWake = { readonly kind: 'router' } | { readonly kind: 'domain'; readonly name: string } | { readonly kind: 'domains-changed' };

export function layout(rootIn: string): Layout {
  const root = nfc(resolve(rootIn));
  const gateway = join(root, '.gateway');
  return {
    root,
    inboxDir: join(root, 'inbox'),
    rejectedDir: join(root, 'inbox', '.rejected'),
    answersInboxDir: (d) => join(root, 'inbox', 'answers', d),
    domainDir: (d) => join(root, d),
    rawDir: (d) => join(root, d, 'raw'),
    holdDir: (d) => join(root, d, 'hold'),
    wikiDir: (d) => join(root, d, 'wiki'),
    inflightFile: (d) => join(gateway, 'inflight', `${d}.json`),
    lockFile: join(gateway, 'lock'),
    rootSchema: join(root, 'CLAUDE.md'),
    commonRules: join(root, '_schema', '공통규칙.md'),
    wikiRel: (d) => `${d}/wiki`,
    logRel: (d) => `${d}/wiki/log.md`,
    indexRel: (d) => `${d}/wiki/index.md`,
    reviewRel: (d) => `${d}/wiki/_review.md`,
    rawRel: (d, name) => `${d}/raw/${name}`,
    toRel(absPath) {
      const rel = relative(root, nfc(resolve(root, absPath)));
      const posix = rel.split(sep).join('/');
      return posix === '' || posix === '..' || posix.startsWith('../') ? null : posix;
    },
    fromRel: (rel) => join(root, ...rel.split('/')),
    wakeFor(rel) {
      const parts = nfc(rel).split('/');
      if (parts[0] === 'inbox') {
        if (parts.length === 2 && parts[1]!.endsWith('.md') && !parts[1]!.startsWith('.')) return { kind: 'router' };
        if (parts[1] === 'answers' && parts.length === 4) return { kind: 'domain', name: parts[2]! };
        return null;
      }
      if (parts.length === 2 && parts[1] === 'CLAUDE.md' && !parts[0]!.startsWith('_') && !parts[0]!.startsWith('.')) return { kind: 'domains-changed' };
      if (parts.length === 3 && parts[1] === 'raw' && !parts[2]!.startsWith('.')) return { kind: 'domain', name: parts[0]! };
      return null;
    },
  };
}

/** Subdirectories of root that contain CLAUDE.md and do not start with `_` or `.`. NFC, sorted. */
export async function listDomainDirs(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (await exists(join(root, e.name, 'CLAUDE.md'))) out.push(nfc(e.name));
  }
  return out.sort();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Visible names in a directory (no dotfiles), NFC; [] when the directory is missing. */
export async function listNames(dir: string): Promise<readonly string[]> {
  try {
    return (await fs.readdir(dir)).map(nfc).filter((n) => !n.startsWith('.')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Every `.md` file under dir, as paths relative to dir with `/` separators. */
export async function listMarkdown(dir: string): Promise<readonly string[]> {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => nfc(relative(dir, join(e.parentPath, e.name)).split(sep).join('/')))
      .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function unlinkQuiet(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}

async function fsyncDir(dir: string): Promise<void> {
  const h = await fs.open(dir, 'r');
  try {
    await h.sync();
  } catch {
    // Some filesystems refuse fsync on a directory; the rename or link is still atomic.
  } finally {
    await h.close();
  }
}

async function writeTmp(dir: string, name: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${name}-${randomBytes(6).toString('hex')}`);
  const h = await fs.open(tmp, 'wx');
  try {
    await h.writeFile(content, 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  return tmp;
}

/** Gives `src` a second name, `dir/name`, unless that name exists. The caller unlinks `src` after. */
export async function linkExclusive(src: string, dir: string, name: string): Promise<'created' | 'exists'> {
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.link(src, join(dir, name));
    await fsyncDir(dir);
    return 'created';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw e;
  }
}

/**
 * Create-if-absent with full content, crash-safe: write a fsynced tmp file, link() it to the
 * name (EEXIST → 'exists'), unlink the tmp file, fsync the directory. A crash leaves at most
 * an orphan `.tmp-*`, which openWiki sweeps.
 */
export async function writeExclusive(dir: string, name: string, content: string): Promise<'created' | 'exists'> {
  const tmp = await writeTmp(dir, name, content);
  try {
    return await linkExclusive(tmp, dir, name);
  } finally {
    await unlinkQuiet(tmp);
  }
}

export async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  const tmp = await writeTmp(dir, basename(path), content);
  await fs.rename(tmp, path);
  await fsyncDir(dir);
}

export async function sweepTmp(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith('.tmp-')) await unlinkQuiet(join(dir, n));
  }
}

/**
 * CLAUDE.md with every whole-line `@relative/path` replaced by that file's content,
 * recursively. Needed because --safe-mode skips CLAUDE.md loading and its imports.
 */
export async function composeSystemPrompt(claudeMdPath: string, seen: ReadonlySet<string> = new Set()): Promise<string> {
  const text = await fs.readFile(claudeMdPath, 'utf8');
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^@(\S.*)$/.exec(line.trim());
    const target = m ? resolve(dirname(claudeMdPath), m[1]!) : null;
    if (target && !seen.has(target) && (await exists(target))) {
      out.push((await composeSystemPrompt(target, new Set([...seen, claudeMdPath]))).trimEnd());
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}


/** Present only while runNext is mid-job. It tells crash leftovers apart from human edits. */
export type InflightMarker = {
  readonly job: JobRef;
  readonly base: string;
  readonly attempt: number;
  readonly since: string;
  /** repo path → sha256 at job start */
  readonly inputs: Readonly<Record<string, string>>;
};

export async function readInflight(path: string): Promise<InflightMarker | null> {
  const text = await readIfExists(path);
  return text === null ? null : (JSON.parse(text) as InflightMarker);
}

export async function writeInflight(path: string, marker: InflightMarker): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(marker, null, 2)}\n`);
}

export const clearInflight = unlinkQuiet;


const execFileP = promisify(execFile);

/** `ps` start time of a live pid, or null when no such process exists. (pid, start) survives pid reuse. */
async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

type LockBody = { readonly pid: number; readonly started: string };

/**
 * One gateway per wiki root. The lock file records (pid, process start time). A lock whose
 * pid is gone, or whose pid now belongs to a process started at another time, is stale.
 */
export async function acquireLock(path: string): Promise<{ release(): Promise<void> }> {
  await fs.mkdir(dirname(path), { recursive: true });
  const me: LockBody = { pid: process.pid, started: (await processStart(process.pid)) ?? '' };
  for (let tries = 0; tries < 3; tries++) {
    try {
      await fs.writeFile(path, JSON.stringify(me), { flag: 'wx' });
      return { release: () => unlinkQuiet(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = await readIfExists(path);
    let body: LockBody | null = null;
    try {
      body = held ? (JSON.parse(held) as LockBody) : null;
    } catch {
      body = null;
    }
    if (body && (await processStart(body.pid)) === body.started) {
      throw new Error(`wiki is locked by a running gateway (pid ${body.pid}): ${path}`);
    }
    await unlinkQuiet(path);
  }
  throw new Error(`could not take the lock: ${path}`);
}

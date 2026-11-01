/**
 * `dotoriwiki init`: a new wiki from a preset, ready for the gateway's first open, and this
 * machine's env file pointing at it. It overwrites nothing: a folder that is not empty is refused,
 * and a key the env file already sets is kept.
 *
 * The first commit holds everything but the domain folders. Those get their `init(<d>)` commits,
 * with a fresh index.md, when the gateway first opens the wiki.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_COMMITTER, LOOPBACK, machinePaths, updateEnvFile } from './machine.ts';
import { CONFIG_FILE, parseWikiConfig, type Locale } from './wiki/index.ts';

const PRESETS = fileURLToPath(new URL('../presets/', import.meta.url));

export type InitResult = {
  readonly root: string;
  readonly locale: Locale;
  readonly timeZone: string;
  readonly envFile: string;
  /** Keys this run added to the env file. The others were already set and kept. */
  readonly added: readonly string[];
  /** WIKI_ROOT as the env file already had it, when that is another folder. */
  readonly otherWikiRoot: string | null;
};

export function localeFromEnv(env: NodeJS.ProcessEnv): Locale {
  return /^ko/i.test(env.LC_ALL || env.LANG || '') ? 'ko' : 'en';
}

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export async function initWiki(dir: string, locale: Locale, env: NodeJS.ProcessEnv): Promise<InitResult> {
  const root = resolve(dir);
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('init needs git on PATH');
  }
  const present = await fs.readdir(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  if (present.length) throw new Error(`${root} is not empty. Give init a new or empty folder.`);

  await fs.cp(join(PRESETS, locale), root, { recursive: true });
  const { timeZone, domains } = await setTimeZone(join(root, CONFIG_FILE));
  git(root, 'init', '-q', '-b', 'main');
  const skeleton = (await fs.readdir(root)).filter((name) => name !== '.git' && !domains.includes(name.normalize('NFC')));
  git(root, 'add', '-A', '--', ...skeleton);
  git(root, ...identity(root), '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'init');

  const envFile = machinePaths(env).envFile;
  const { changed, had } = await updateEnvFile(envFile, [
    ['WIKI_ROOT', root],
    ['PORT', '8787'],
    ['HOST', LOOPBACK],
    ['GATEWAY_TOKEN', randomBytes(24).toString('hex')],
  ]);
  const kept = had.get('WIKI_ROOT');
  return { root, locale, timeZone, envFile, added: changed, otherWikiRoot: kept !== undefined && resolve(kept) !== root ? kept : null };
}

/** The user's own git identity when they have one, else the gateway's. */
function identity(root: string): string[] {
  try {
    git(root, 'var', 'GIT_COMMITTER_IDENT');
    return [];
  } catch {
    return ['-c', `user.name=${GATEWAY_COMMITTER.name}`, '-c', `user.email=${GATEWAY_COMMITTER.email}`];
  }
}

/** This machine's zone in place of the preset's, unless Intl names one the config would refuse. */
async function setTimeZone(file: string): Promise<{ timeZone: string; domains: readonly string[] }> {
  const preset = await fs.readFile(file, 'utf8');
  const text = preset.replace(/^time_zone: .*$/m, `time_zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  const parsed = parseWikiConfig(text, { modelProfiles: new Set() });
  const used = parsed.ok ? parsed : parseWikiConfig(preset, { modelProfiles: new Set() });
  if (!used.ok) throw new Error(`the preset's ${CONFIG_FILE} does not parse: ${used.problems.map((p) => p.key).join(', ')}`);
  if (used === parsed) await fs.writeFile(file, text);
  return { timeZone: used.config.timeZone, domains: [...used.config.domains.keys()] };
}

/**
 * The machine's side of the gateway, outside any wiki: the settings it reads from its environment,
 * where its env file, models.json, and chat transcripts live, and the env file's format. HOME is
 * read from the env passed in, so a test or script can point all of it at a temp folder.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

export type Config = {
  readonly wikiRoot: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly claudeBin: string;
  readonly codexBin: string;
  readonly ytDlpBin: string;
  readonly modelsFile: string;
  readonly chatsDir: string;
  readonly collectFeeds: boolean;
};

export type MachinePaths = { readonly envFile: string; readonly modelsFile: string; readonly chatsDir: string };

export function machinePaths(env: NodeJS.ProcessEnv): MachinePaths {
  const home = env.HOME || homedir();
  const configDir = join(home, '.config', 'dotoriwiki');
  return {
    envFile: env.DOTORIWIKI_ENV || join(configDir, 'gateway.env'),
    modelsFile: join(configDir, 'models.json'),
    chatsDir: join(home, '.local', 'share', 'dotoriwiki', 'chats'),
  };
}

/** init's HOST, which install replaces with the Tailscale address. */
export const LOOPBACK = '127.0.0.1';

export const GATEWAY_COMMITTER = { name: 'dotoriwiki-gateway', email: 'gateway@localhost' } as const;

/**
 * WIKI_ROOT, GATEWAY_TOKEN required; PORT (8787), HOST (127.0.0.1, set the Tailscale address),
 * CLAUDE_BIN (claude), CODEX_BIN (codex), YT_DLP_BIN (yt-dlp), MODELS_FILE
 * (~/.config/dotoriwiki/models.json), CHATS_DIR (~/.local/share/dotoriwiki/chats), COLLECT_FEEDS (on;
 * `off` for a test gateway) optional.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const wikiRoot = env.WIKI_ROOT ?? '';
  if (!isAbsolute(wikiRoot)) throw new Error('WIKI_ROOT must be an absolute path');
  const token = env.GATEWAY_TOKEN ?? '';
  if (token.length < 16) throw new Error('GATEWAY_TOKEN must be at least 16 characters');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  const host = env.HOST ?? LOOPBACK;
  if (host === '0.0.0.0' || host === '::') throw new Error('HOST must be one address (the Tailscale one), not all interfaces');
  const paths = machinePaths(env);
  const modelsFile = env.MODELS_FILE ?? paths.modelsFile;
  if (!isAbsolute(modelsFile)) throw new Error('MODELS_FILE must be an absolute path');
  const chatsDir = env.CHATS_DIR ?? paths.chatsDir;
  if (!isAbsolute(chatsDir)) throw new Error('CHATS_DIR must be an absolute path');
  const fromWiki = relative(wikiRoot, chatsDir);
  if (fromWiki !== '..' && !fromWiki.startsWith('../')) throw new Error('CHATS_DIR must be outside WIKI_ROOT: chat transcripts never enter the wiki');
  return {
    wikiRoot, host, port, token, claudeBin: env.CLAUDE_BIN ?? 'claude', codexBin: env.CODEX_BIN || 'codex', ytDlpBin: env.YT_DLP_BIN ?? 'yt-dlp', modelsFile, chatsDir,
    collectFeeds: env.COLLECT_FEEDS !== 'off',
  };
}

/** The env file stays valid shell for `source`, so a value is either bare or single-quoted. */
const BARE = /^[\w@%+=:,./-]*$/;

export function envLine(key: string, value: string): string {
  return `${key}=${BARE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`}`;
}

/** KEY=value lines as envLine writes them. Comments and other lines are skipped. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2]!;
    out.set(m[1]!, v.length >= 2 && v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replaceAll(`'\\''`, "'") : v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
  }
  return out;
}

export async function readEnvFile(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
}

/** The env file's settings with the process env over them: a variable set in the environment wins. */
export function withEnvFile(env: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(parseEnvFile(text)), ...env };
}

/** What `start` reads: the env file under the process env. */
export async function machineEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const file = machinePaths(env).envFile;
  const text = await readEnvFile(file);
  if (text === null) throw new Error(`${file} does not exist. Run \`dotoriwiki init\` first, or set DOTORIWIKI_ENV to your env file.`);
  return withEnvFile(env, text);
}

/**
 * The env file text with each entry set. A key the text lacks is appended. A key it has keeps its
 * value unless `replace(key, old)` says otherwise, and then its line is rewritten in place.
 */
export function mergeEnv(
  before: string,
  entries: readonly (readonly [string, string])[],
  replace: (key: string, old: string) => boolean = () => false,
): { readonly text: string; readonly changed: readonly string[] } {
  const had = parseEnvFile(before);
  const changed: string[] = [];
  const appended: string[] = [];
  let lines = before.split('\n');
  for (const [key, value] of entries) {
    const old = had.get(key);
    if (old === undefined) {
      appended.push(envLine(key, value));
      changed.push(key);
    } else if (old !== value && replace(key, old)) {
      lines = lines.map((l) => (parseEnvFile(l).has(key) ? envLine(key, value) : l));
      changed.push(key);
    }
  }
  const text = lines.join('\n');
  if (!appended.length) return { text, changed };
  return { text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${appended.join('\n')}\n`, changed };
}

/** Merges entries into the env file, which holds the token: mode 0600, in a 0700 folder when new. */
export async function updateEnvFile(
  file: string,
  entries: readonly (readonly [string, string])[],
  replace?: (key: string, old: string) => boolean,
): Promise<{ readonly text: string; readonly changed: readonly string[]; readonly had: ReadonlyMap<string, string> }> {
  const before = (await readEnvFile(file)) ?? '';
  const { text, changed } = mergeEnv(before, entries, replace);
  if (changed.length) {
    await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, text, 0o600);
  }
  return { text, changed, had: parseEnvFile(before) };
}

export async function writeFileAtomic(file: string, text: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode });
  // writeFile's mode applies only to a file it creates, and umask narrows it.
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

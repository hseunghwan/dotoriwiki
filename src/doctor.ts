/**
 * `dotoriwiki doctor`: whether this machine and its wiki are ready for the gateway. Read-only: it
 * takes no lock and writes nothing, so it is safe beside a running gateway. Each check reuses the
 * rule the gateway itself applies: loadConfig for the env file, loadModels for models.json,
 * checkWiki for what openWiki and the config rule look at.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execRun, type Run } from './enrich.ts';
import { loadConfig, machinePaths, parseEnvFile, type Config } from './machine.ts';
import { loadModels, profileNames, type Models } from './models.ts';
import { SIPS } from './shrink.ts';
import { checkWiki, CONFIG_FILE } from './wiki/index.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
export type Check = { readonly status: CheckStatus; readonly what: string; readonly fix: string | null };

const VERSION_TIMEOUT_MS = 15_000;

export async function doctor(env: NodeJS.ProcessEnv, run: Run = execRun): Promise<readonly Check[]> {
  const checks: Check[] = [];
  const add = (status: CheckStatus, what: string, fix: string | null = null) => void checks.push({ status, what, fix });
  const version = async (bin: string) => {
    const r = await run(bin, ['--version'], VERSION_TIMEOUT_MS);
    return r.code === 0 ? (r.stdout.trim().split('\n')[0] ?? '') : null;
  };

  const node = process.versions.node;
  const min = /(\d+)\.(\d+)/.exec(await engines())!;
  const [major, minor] = node.split('.').map(Number) as [number, number];
  if (process.features.typescript && (major > Number(min[1]) || (major === Number(min[1]) && minor >= Number(min[2])))) add('pass', `Node ${node} runs TypeScript directly`);
  else add('fail', `Node ${node} is older than ${min[0]}`, `install Node ${min[0]} or newer`);

  const gitVersion = await version('git');
  if (gitVersion) add('pass', gitVersion);
  else add('fail', 'git is not on PATH', 'install git');

  const cfg = await envConfig(env, add);
  if (!cfg) {
    add('info', 'skipped the wiki and program checks, which need the env file');
    return checks;
  }

  let models: Models | null = null;
  try {
    const present = await fs.access(cfg.modelsFile).then(() => true, () => false);
    models = loadModels(cfg.modelsFile);
    add('pass', present ? `${cfg.modelsFile} parses` : `no ${cfg.modelsFile}, so the Claude defaults apply`);
  } catch (e) {
    add('fail', (e as Error).message, `fix the entry it names, or remove ${cfg.modelsFile} to use the Claude defaults`);
  }

  await wikiChecks(cfg, models, add);

  const claude = await version(cfg.claudeBin);
  if (claude) add('pass', `${cfg.claudeBin} --version: ${claude}. Its login is not checked, because that would spend a request.`);
  else add('fail', `${cfg.claudeBin} --version did not run`, 'install Claude Code and log in once with `claude`, or set CLAUDE_BIN in the env file');

  const usesCodex = models && [models.classify, models.edit.default, ...models.edit.profiles.values()].some((c) => c.provider === 'codex');
  if (usesCodex) {
    const codex = await version(cfg.codexBin);
    if (codex) add('pass', `${cfg.codexBin} --version: ${codex}`);
    else add('fail', `models.json uses codex, and ${cfg.codexBin} --version did not run`, 'install the Codex CLI and log in, or set CODEX_BIN in the env file');
  }

  const ytDlp = await version(cfg.ytDlpBin);
  if (ytDlp) add('pass', `${cfg.ytDlpBin} ${ytDlp}`);
  else add('warn', `${cfg.ytDlpBin} is not installed, so a memo's video links get no transcript`, 'install yt-dlp, or set YT_DLP_BIN in the env file');

  if (await fs.access(SIPS).then(() => true, () => false)) add('pass', `${SIPS} shrinks photos`);
  else add('warn', `${SIPS} is missing, so a memo with photos cannot be saved here. Text memos work.`, 'photo shrinking needs macOS for now');

  return checks;
}

async function engines(): Promise<string> {
  return (JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } }).engines.node;
}

/** The env file merged over the process env, as launchd's `source` does, then loadConfig. */
async function envConfig(env: NodeJS.ProcessEnv, add: (status: CheckStatus, what: string, fix?: string | null) => void): Promise<Config | null> {
  const file = machinePaths(env).envFile;
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    await legacyMachine(env, add);
    add('fail', `the env file ${file} does not exist`, 'run `init` to create it, or set DOTORIWIKI_ENV to the env file the gateway reads');
    return null;
  }
  if (((await fs.stat(file)).mode & 0o077) !== 0) add('warn', `${file} is readable by other users, and it holds the gateway token`, `chmod 600 ${file}`);
  let cfg: Config;
  try {
    cfg = loadConfig({ ...env, ...Object.fromEntries(parseEnvFile(text)) });
  } catch (e) {
    add('fail', `${file}: ${(e as Error).message}`, `edit ${file}`);
    return null;
  }
  add('pass', `${file} sets WIKI_ROOT ${cfg.wikiRoot} and http://${cfg.host}:${cfg.port}`);
  if (cfg.host === '127.0.0.1' || cfg.host === 'localhost') {
    add('warn', `HOST is ${cfg.host}, so only this machine reaches the gateway`, `set HOST in ${file} to this machine's Tailscale address before pairing a phone`);
  }
  return cfg;
}

/** The settings a gateway from before the rename kept under ~/.config/llmwiki. */
async function legacyMachine(env: NodeJS.ProcessEnv, add: (status: CheckStatus, what: string, fix?: string | null) => void): Promise<void> {
  const home = env.HOME || homedir();
  const old = join(home, '.config', 'llmwiki');
  if (!(await fs.access(join(old, 'gateway.env')).then(() => true, () => false))) return;
  const { modelsFile, chatsDir } = machinePaths(env);
  const configDir = dirname(modelsFile);
  add('warn', `${old} holds an env file from before the rename to dotoriwiki`, [
    `mkdir -p ${configDir} ${dirname(chatsDir)}`,
    `mv ${old}/* ${configDir}/`,
    `mv ${join(home, '.local', 'share', 'llmwiki', 'chats')} ${chatsDir}`,
  ].join(' && '));
}

async function wikiChecks(cfg: Config, models: Models | null, add: (status: CheckStatus, what: string, fix?: string | null) => void): Promise<void> {
  const root = cfg.wikiRoot;
  if (!(await fs.stat(root).then((s) => s.isDirectory(), () => false))) {
    add('fail', `WIKI_ROOT ${root} is not a folder`, `run \`init ${root}\`, or point WIKI_ROOT at your wiki`);
    return;
  }
  const c = await checkWiki(root, { modelProfiles: new Set(models ? profileNames(models) : ['default']) });
  if (c.workTree) add('pass', `${root} is a git work tree`);
  else add('fail', `${root} is not a git work tree`, `run \`git init -b main\` in ${root}`);

  if (!c.config) add('fail', `${root}/${CONFIG_FILE} does not exist`, 'restore it from git, or run `init` in a new folder');
  else if (!c.config.ok) for (const p of c.config.problems) add('fail', `${CONFIG_FILE} ${p.key}: ${p.problem}`, p.fix);
  else {
    const { domains, locale, timeZone } = c.config.config;
    add('pass', `${CONFIG_FILE} parses: ${[...domains.keys()].join(', ')} (${locale}, ${timeZone}), each with its CLAUDE.md`);
    for (const p of c.config.warnings) add('warn', `${CONFIG_FILE} ${p.key}: ${p.problem}`, p.fix);
  }

  if (c.originalsIgnored === true) add('pass', '_originals/ is gitignored');
  else if (c.originalsIgnored === false) add('fail', '_originals/ is not gitignored, and original photos keep their GPS', `add the line \`_originals/\` to ${root}/.gitignore`);

  add('info', c.lockedBy === null ? 'no gateway is running on this wiki' : `a gateway is running on this wiki (pid ${c.lockedBy})`);
}

/**
 * `dotoriwiki install` and `uninstall`: the gateway as this user's service. install is safe to
 * rerun. It adds what the env file lacks and keeps every value it already has, but for a HOST of
 * 127.0.0.1, which it moves to the Tailscale address. Then it rewrites the service file and
 * restarts the service. uninstall removes the service and leaves the env file and the wiki.
 */

import { promises as fs } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { Run } from './enrich.ts';
import { LOOPBACK, loadConfig, machinePaths, mergeEnv, parseEnvFile, readEnvFile, writeFileAtomic, type Config } from './machine.ts';
import { servicePath, type Platform, type ServiceKind } from './service.ts';

/** Starting and stopping the service in its manager: launchctl or systemctl. */
export type ServiceControl = {
  /** Loads the service from its file, replacing a running copy. Returns notes for the user. */
  readonly restart: (file: string) => Promise<readonly string[]>;
  /** Stops and unloads the service, then removes its file. */
  readonly remove: (file: string) => Promise<void>;
};

export type ServiceDeps = { readonly platform: Platform; readonly control: ServiceControl; readonly run: Run };

export type InstallResult = {
  readonly envFile: string;
  /** Env file keys this run added or changed. */
  readonly changed: readonly string[];
  readonly serviceFile: string;
  /** The settings the service starts with. */
  readonly config: Config;
  /** Programs the gateway runs that are not on PATH. */
  readonly missing: readonly string[];
  readonly notes: readonly string[];
};

export const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const RUN_TIMEOUT_MS = 30_000;

export async function findOnPath(name: string, pathEnv: string): Promise<string | null> {
  if (isAbsolute(name)) return (await executable(name)) ? name : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (isAbsolute(dir) && (await executable(join(dir, name)))) return join(dir, name);
  }
  return null;
}

const executable = (file: string) => fs.stat(file).then(async (s) => s.isFile() && (await fs.access(file, fs.constants.X_OK).then(() => true, () => false)), () => false);

/** Tailscale's CLI on PATH, then the macOS app's binary, which the app does not put on PATH. */
export async function tailscaleCandidates(pathEnv: string): Promise<string[]> {
  return [await findOnPath('tailscale', pathEnv), TAILSCALE_APP].filter((b): b is string => b !== null);
}

/** The first IPv4 address the first working Tailscale CLI reports, or null when none is up. */
export async function tailscaleIPv4(candidates: readonly string[], run: Run): Promise<string | null> {
  for (const bin of candidates) {
    const r = await run(bin, ['ip', '-4'], RUN_TIMEOUT_MS);
    const ip = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).find((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l)) : undefined;
    if (ip) return ip;
  }
  return null;
}

/**
 * The programs the gateway runs. `record`: install writes the absolute path into the env file, so
 * the service finds it without the user's shell PATH. `optional`: not reported when missing.
 */
const PROGRAMS = [
  { key: 'CLAUDE_BIN', name: 'claude', record: true, optional: false },
  { key: 'CODEX_BIN', name: 'codex', record: true, optional: true },
  { key: 'YT_DLP_BIN', name: 'yt-dlp', record: false, optional: false },
] as const;

export async function install(env: NodeJS.ProcessEnv, program: readonly string[], deps: ServiceDeps): Promise<InstallResult> {
  if (process.getuid?.() === 0) throw new Error('run install as the user who owns the wiki, not as root');
  const home = env.HOME || homedir();
  const { envFile } = machinePaths(env);
  const before = await readEnvFile(envFile);
  if (before === null) throw new Error(`${envFile} does not exist. Run \`dotoriwiki init\` first.`);
  const had = parseEnvFile(before);
  const pathEnv = env.PATH ?? '';

  const host = env.HOST ?? (await tailscaleIPv4(await tailscaleCandidates(pathEnv), deps.run));
  const found = await Promise.all(PROGRAMS.map(async (p) => ({ ...p, bin: await findOnPath(had.get(p.key) ?? env[p.key] ?? p.name, pathEnv) })));
  const entries: [string, string][] = [];
  if (host) entries.push(['HOST', host]);
  for (const p of found) if (p.bin && p.record) entries.push([p.key, p.bin]);
  const { text, changed } = mergeEnv(before, entries, (key, old) => key === 'HOST' && old === LOOPBACK);
  // The service sees the env file and what the service file sets, not this shell's environment.
  const config = loadConfig({ ...Object.fromEntries(parseEnvFile(text)), HOME: home, DOTORIWIKI_ENV: envFile });
  if (changed.length) await writeFileAtomic(envFile, text, 0o600);

  const git = await findOnPath('git', pathEnv);
  const dirs = [program[0]!, ...found.map((p) => p.bin), git].filter((b): b is string => b !== null).map(dirname);
  const serviceFile = deps.platform.file(home, env);
  const logs = deps.platform.logs(home);
  // launchd opens the log file but does not make its folder.
  if (isAbsolute(logs)) await fs.mkdir(dirname(logs), { recursive: true });
  await fs.mkdir(dirname(serviceFile), { recursive: true });
  await writeFileAtomic(serviceFile, deps.platform.render({ program: [...program, 'start'], path: servicePath(deps.platform, dirs), home, envFile }), 0o644);
  const notes = await deps.control.restart(serviceFile);
  const missing = found.filter((p) => !p.bin && !p.optional).map((p) => p.name);
  return { envFile, changed, serviceFile, config, missing, notes };
}

export async function uninstall(env: NodeJS.ProcessEnv, deps: ServiceDeps): Promise<{ readonly serviceFile: string; readonly existed: boolean }> {
  const serviceFile = deps.platform.file(env.HOME || homedir(), env);
  const existed = await fs.access(serviceFile).then(() => true, () => false);
  await deps.control.remove(serviceFile);
  return { serviceFile, existed };
}

/** GET /status, or null when nothing answers with 200 within the timeout. */
export async function gatewayStatus(url: string, token: string, timeoutMs = 5000): Promise<unknown> {
  try {
    const res = await fetch(`${url}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function waitForStatus(url: string, token: string, timeoutMs: number): Promise<unknown> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = await gatewayStatus(url, token, 2000);
    if (status || Date.now() > until) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const CONTROLS: { readonly [K in ServiceKind]: (run: Run, name: string) => ServiceControl } = {
  launchd: launchdControl,
  systemd: systemdControl,
};

async function check(run: Run, bin: string, args: readonly string[]): Promise<string> {
  const r = await run(bin, args, RUN_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function launchdControl(run: Run, label: string): ServiceControl {
  const domain = `gui/${process.getuid!()}`;
  const loaded = async () => (await run('launchctl', ['print', `${domain}/${label}`], RUN_TIMEOUT_MS)).code === 0;
  const bootout = async () => {
    await run('launchctl', ['bootout', `${domain}/${label}`], RUN_TIMEOUT_MS);
    // bootout returns before the job is gone, and bootstrapping too early fails with EIO.
    for (let i = 0; i < 40 && (await loaded()); i++) await new Promise((r) => setTimeout(r, 500));
  };
  return {
    restart: async (file) => {
      await bootout();
      await check(run, 'launchctl', ['bootstrap', domain, file]);
      return [];
    },
    remove: async (file) => {
      await bootout();
      await fs.rm(file, { force: true });
    },
  };
}

const NO_BUS = 'systemctl --user could not reach your user manager. Run install from a login session (ssh or a desktop terminal, not su or sudo), or set XDG_RUNTIME_DIR=/run/user/$(id -u).';

function systemdControl(run: Run, unit: string): ServiceControl {
  const systemctl = (...args: string[]) => check(run, 'systemctl', ['--user', ...args]).catch((e: Error) => {
    throw new Error(/bus|XDG_RUNTIME_DIR/i.test(e.message) ? `${e.message}\n${NO_BUS}` : e.message);
  });
  return {
    restart: async () => {
      await systemctl('daemon-reload');
      await systemctl('enable', unit);
      await systemctl('restart', unit);
      return linger(run);
    },
    remove: async (file) => {
      if (await fs.access(file).then(() => true, () => false)) await systemctl('disable', '--now', unit);
      await fs.rm(file, { force: true });
      await systemctl('daemon-reload');
    },
  };
}

/** Without lingering, systemd stops user services at logout and starts them only at login. */
async function linger(run: Run): Promise<string[]> {
  const user = userInfo().username;
  const now = await run('loginctl', ['show-user', user, '--property=Linger', '--value'], RUN_TIMEOUT_MS);
  if (now.stdout.trim() === 'yes') return [];
  const r = await run('loginctl', ['enable-linger', user], RUN_TIMEOUT_MS);
  return r.code === 0
    ? [`Turned on lingering for ${user}, so the gateway runs while you are logged out and starts at boot.`]
    : [`The gateway stops when you log out. To keep it running and start it at boot: sudo loginctl enable-linger ${user}`];
}

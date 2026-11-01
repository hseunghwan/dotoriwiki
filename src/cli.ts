#!/usr/bin/env node
/**
 * The dotoriwiki command. In a checkout: `node src/cli.ts <command>`, or `npm run dotoriwiki -- <command>`.
 *
 *   init [dir] [--locale en|ko]   a new wiki from a preset (dir defaults to the current folder),
 *                                 and this machine's env file pointing at it
 *   doctor                        whether this machine and its wiki are ready; exits 1 on a fail
 *   install                       the gateway as this user's service (launchd or systemd), started
 *                                 now and at every login or boot; safe to rerun
 *   uninstall                     stops and removes the service, keeping the env file and the wiki
 *   pair [--show-token]           the QR the phone app scans, once the gateway answers
 *   start                         the gateway in this process, on the env file's settings under
 *                                 the environment's; what the service runs
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { doctor, type Check } from './doctor.ts';
import { execRun } from './enrich.ts';
import { initWiki, localeFromEnv } from './init.ts';
import { CONTROLS, install, uninstall, waitForStatus, type ServiceDeps } from './install.ts';
import { LOOPBACK, loadConfig, machineEnv, packageJson } from './machine.ts';
import { startGateway } from './main.ts';
import { pairing } from './pair.ts';
import { platformFor } from './service.ts';
import type { Locale } from './wiki/index.ts';

const USAGE = [
  'usage: dotoriwiki init [dir] [--locale en|ko]',
  '       dotoriwiki doctor',
  '       dotoriwiki install',
  '       dotoriwiki uninstall',
  '       dotoriwiki pair [--show-token]',
  '       dotoriwiki start',
].join('\n');
const LANGUAGE: Record<Locale, string> = { en: 'an English', ko: 'a Korean' };
const STATUS_WAIT_MS = 30_000;

/** An exit code, or null for a command that keeps running. */
type Command = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number | null>;

const COMMANDS: Record<string, Command> = {
  init: async (args, env) => {
    const { values, positionals } = parseArgs({ args: [...args], options: { locale: { type: 'string' } }, allowPositionals: true });
    const locale = values.locale ?? localeFromEnv(env);
    if ((locale !== 'en' && locale !== 'ko') || positionals.length > 1) return usage();
    // npm run starts scripts in the package folder; INIT_CWD is where the user typed the command.
    const r = await initWiki(resolve(env.INIT_CWD ?? process.cwd(), positionals[0] ?? '.'), locale, env);
    console.log(`Created ${LANGUAGE[r.locale]} wiki at ${r.root} (time zone ${r.timeZone}) and committed it.`);
    console.log(r.added.length ? `Added ${r.added.join(', ')} to ${r.envFile}.` : `${r.envFile} already sets every key init writes.`);
    if (r.otherWikiRoot) console.log(`\nWIKI_ROOT in ${r.envFile} still names ${r.otherWikiRoot}, so the gateway keeps serving that wiki. Change it to ${r.root} to switch.`);
    console.log([
      '',
      'Next:',
      '  1. Check this machine:      dotoriwiki doctor',
      '  2. Log in to Claude Code:   claude   (once, if you have not)',
      '  3. Run the gateway:         dotoriwiki install',
      '  4. Pair the phone app:      dotoriwiki pair',
    ].join('\n'));
    return 0;
  },

  doctor: async (args, env) => {
    if (args.length) return usage();
    const checks = await doctor(env);
    for (const c of checks) console.log(formatCheck(c));
    const failed = checks.filter((c) => c.status === 'fail').length;
    console.log(failed ? `\n${failed} check(s) failed.` : '\nReady.');
    return failed ? 1 : 0;
  },

  install: async (args, env) => {
    if (args.length) return usage();
    const deps = serviceDeps();
    const r = await install(env, [process.execPath, fileURLToPath(import.meta.url)], deps);
    const { host, port, token } = r.config;
    console.log(r.changed.length ? `Set ${r.changed.join(', ')} in ${r.envFile}.` : `${r.envFile} already had every value install sets.`);
    console.log(`Wrote ${r.serviceFile} and started ${deps.platform.name}.`);
    for (const note of r.notes) console.log(note);
    if (r.missing.length) console.log(`Not on PATH: ${r.missing.join(', ')}. \`dotoriwiki doctor\` says what each is for.`);
    if (host === LOOPBACK) console.log(`HOST is ${LOOPBACK}, so only this machine reaches the gateway. For the phone, run install again with Tailscale up and HOST not set in your shell.`);
    const url = `http://${host}:${port}`;
    if (!(await waitForStatus(url, token, STATUS_WAIT_MS))) {
      console.error(`\nThe gateway did not answer at ${url} within ${STATUS_WAIT_MS / 1000} s. Its log: ${deps.platform.logs(env.HOME || homedir())}`);
      return 1;
    }
    console.log(`\nThe gateway answers at ${url}. Logs: ${deps.platform.logs(env.HOME || homedir())}\nNext: dotoriwiki pair`);
    return 0;
  },

  uninstall: async (args, env) => {
    if (args.length) return usage();
    const deps = serviceDeps();
    const r = await uninstall(env, deps);
    console.log(r.existed ? `Stopped ${deps.platform.name} and removed ${r.serviceFile}.` : `No service file at ${r.serviceFile}. Made sure ${deps.platform.name} is stopped.`);
    console.log('The env file and the wiki are unchanged.');
    return 0;
  },

  pair: async (args, env) => {
    const { values } = parseArgs({ args: [...args], options: { 'show-token': { type: 'boolean' } } });
    const cfg = loadConfig(await machineEnv(env));
    const p = await pairing(cfg, packageJson().version, env.PATH ?? '', execRun);
    if (!('url' in p)) {
      const logs = platformFor(process.platform)?.logs(env.HOME || homedir());
      console.error(`The gateway does not answer at ${p.tried.join(' or ')}. Is it running (\`dotoriwiki install\`) and is Tailscale up?${logs ? ` Its log: ${logs}` : ''}`);
      return 1;
    }
    const domains = Object.keys(p.status.domains);
    console.log(p.qr);
    console.log('Scan this QR from the app\'s first screen.');
    console.log(`Connected: server ${p.status.server}, ${domains.length} domain(s) (${domains.join(', ')}).`);
    console.log(`Address, to type it in: ${p.url}`);
    if (cfg.host === LOOPBACK) console.log(`HOST is ${LOOPBACK}, which a phone cannot reach. Run \`dotoriwiki install\` with Tailscale up, then pair again.`);
    console.log(values['show-token'] ? `Token: ${cfg.token}` : 'The token is GATEWAY_TOKEN in the env file. To print it: dotoriwiki pair --show-token');
    return 0;
  },

  start: async (args, env) => {
    if (args.length) return usage();
    await startGateway(env);
    return null;
  },
};

function usage(): number {
  console.error(USAGE);
  return 2;
}

function formatCheck(c: Check): string {
  return `${c.status.padEnd(4)}  ${c.what}${c.fix ? `\n      fix: ${c.fix}` : ''}`;
}

function serviceDeps(): ServiceDeps {
  const platform = platformFor(process.platform);
  if (!platform) throw new Error(`install supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
  return { platform, control: CONTROLS[platform.kind](execRun, platform.name), run: execRun };
}

const [command = '', ...rest] = process.argv.slice(2);
(Object.hasOwn(COMMANDS, command) ? COMMANDS[command]! : async () => usage())(rest, process.env).then(
  (code) => code === null || process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);

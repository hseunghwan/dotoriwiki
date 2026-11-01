#!/usr/bin/env node
/**
 * The dotoriwiki command: `node src/cli.ts <command>`, or `npm run dotoriwiki -- <command>`.
 *
 *   init [dir] [--locale en|ko]   a new wiki from a preset (dir defaults to the current folder),
 *                                 and this machine's env file pointing at it
 *   doctor                        whether this machine and its wiki are ready; exits 1 on a fail
 *   start                         the gateway in this process, on the env file's settings under
 *                                 the environment's
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doctor, type Check } from './doctor.ts';
import { initWiki, localeFromEnv } from './init.ts';
import { startGateway } from './main.ts';
import type { Locale } from './wiki/index.ts';

const USAGE = 'usage: dotoriwiki init [dir] [--locale en|ko]\n       dotoriwiki doctor\n       dotoriwiki start';
const LANGUAGE: Record<Locale, string> = { en: 'an English', ko: 'a Korean' };

function formatCheck(c: Check): string {
  return `${c.status.padEnd(4)}  ${c.what}${c.fix ? `\n      fix: ${c.fix}` : ''}`;
}

/** An exit code, or null for a command that keeps running. */
async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  const [command, ...rest] = argv;
  if (command === 'start' && rest.length === 0) {
    await startGateway(env);
    return null;
  }
  if (command === 'doctor' && rest.length === 0) {
    const checks = await doctor(env);
    for (const c of checks) console.log(formatCheck(c));
    const failed = checks.filter((c) => c.status === 'fail').length;
    console.log(failed ? `\n${failed} check(s) failed.` : '\nReady.');
    return failed ? 1 : 0;
  }
  if (command === 'init') {
    const { values, positionals } = parseArgs({ args: [...rest], options: { locale: { type: 'string' } }, allowPositionals: true });
    const locale = values.locale ?? localeFromEnv(env);
    if ((locale !== 'en' && locale !== 'ko') || positionals.length > 1) {
      console.error(USAGE);
      return 2;
    }
    // npm run starts scripts in the package folder; INIT_CWD is where the user typed the command.
    const r = await initWiki(resolve(env.INIT_CWD ?? process.cwd(), positionals[0] ?? '.'), locale, env);
    const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    console.log(`Created ${LANGUAGE[r.locale]} wiki at ${r.root} (time zone ${r.timeZone}) and committed it.`);
    console.log(r.added.length ? `Added ${r.added.join(', ')} to ${r.envFile}.` : `${r.envFile} already sets every key init writes.`);
    if (r.otherWikiRoot) console.log(`\nWIKI_ROOT in ${r.envFile} still names ${r.otherWikiRoot}, so the gateway keeps serving that wiki. Change it to ${r.root} to switch.`);
    console.log([
      '',
      'Next:',
      '  1. Check this machine:     npm run dotoriwiki -- doctor',
      '  2. Log in to Claude Code:  claude   (once, if you have not)',
      `  3. Start the gateway:      set -a; source ${q(r.envFile)}; set +a; npm start`,
      `  4. To use the phone app, set HOST in ${r.envFile} to this machine's Tailscale address, restart the gateway, and run npm run pair.`,
    ].join('\n'));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2), process.env).then(
  (code) => code === null || process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);

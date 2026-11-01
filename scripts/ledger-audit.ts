/**
 * Read-only check that every job in a wiki folds the same under the current ledger parser as
 * under the pre-P2 one. Run it on a copy of a wiki before switching a gateway onto it:
 *
 *   node scripts/ledger-audit.ts ~/wiki-copy
 *
 * Reads every <domain>/wiki/log.md at HEAD, prints each job whose history differs, and exits 1
 * when any does.
 */

import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parseLedger as parseLegacy } from './legacy-ledger.ts';
import { lineKey, parseLedger, verdictText, type JobHistory, type JobKind } from '../src/wiki/index.ts';

/** The current history in the pre-P2 shape: a known verdict becomes the Korean word the old gateway wrote for it. */
function asLegacy(h: JobHistory) {
  const t = h.terminal;
  return { ...h, terminal: t?.kind === 'applied' ? { ...t, verdict: verdictText('ko', t.verdict) } : t };
}

/** The jobs in one log.md, and a message for each whose history differs between the two parsers. */
export function auditLog(text: string): { readonly jobs: number; readonly diffs: readonly string[] } {
  const before = parseLegacy(text);
  const after = parseLedger(text);
  const keys = new Set(text.split('\n').map(lineKey).filter((k) => k !== null));
  const diffs: string[] = [];
  for (const key of keys) {
    const [kind, id] = key.split(/:(.*)/s) as [JobKind, string];
    const was = before.history(kind, id);
    const now = asLegacy(after.history(kind, id));
    if (!isDeepStrictEqual(now, was)) diffs.push(`${key}\n  before ${JSON.stringify(was)}\n  after  ${JSON.stringify(now)}`);
  }
  return { jobs: keys.size, diffs };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node scripts/ledger-audit.ts <wiki root>');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const logs = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter((p) => /^[^/]+\/wiki\/log\.md$/.test(p));
  let jobs = 0;
  let differ = 0;
  for (const path of logs) {
    const r = auditLog(git('show', `HEAD:${path}`));
    jobs += r.jobs;
    differ += r.diffs.length;
    console.log(`${path}: ${r.jobs} job(s), ${r.diffs.length} differ`);
    for (const m of r.diffs) console.log(m);
  }
  console.log(`${logs.length} log(s), ${jobs} job(s) folded, ${differ} differ`);
  process.exit(differ ? 1 : 0);
}

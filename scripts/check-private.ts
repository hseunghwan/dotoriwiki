/**
 * Fails when a file in the repo matches one of your private patterns: names, home paths, addresses.
 * The pattern list lives outside the repo, because committing it would publish what it guards.
 *
 *   npm run check:private                     tracked and untracked files, ignored ones skipped
 *   npm run check:private -- --history        every blob in every commit as well
 *
 * Patterns: one regular expression per line, `#` starts a comment. Read from
 * $DOTORIWIKI_PRIVATE_PATTERNS, else ~/.config/dotoriwiki/private-patterns.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const patternsPath = process.env.DOTORIWIKI_PRIVATE_PATTERNS ?? join(homedir(), '.config/dotoriwiki/private-patterns');
const patterns = readFileSync(patternsPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => new RegExp(l, 'u'));

const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repo, maxBuffer: 1 << 30 });

function* files(): Generator<{ where: string; text: Buffer }> {
  for (const path of git('ls-files', '-z', '-co', '--exclude-standard').toString('utf8').split('\0').filter(Boolean)) {
    yield { where: path, text: readFileSync(join(repo, path)) };
  }
  if (!process.argv.includes('--history')) return;
  const hasCommits = (() => { try { git('rev-parse', '--verify', 'HEAD'); return true; } catch { return false; } })();
  if (!hasCommits) return;
  for (const line of git('rev-list', '--all', '--objects').toString('utf8').split('\n').filter((l) => l.includes(' '))) {
    const [sha, path] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
    if (git('cat-file', '-t', sha).toString().trim() !== 'blob') continue;
    yield { where: `${path} (${sha.slice(0, 7)})`, text: git('cat-file', 'blob', sha) };
  }
}

let hits = 0;
for (const { where, text } of files()) {
  if (text.includes(0)) continue;
  text.toString('utf8').split('\n').forEach((line, i) => {
    for (const p of patterns) if (p.test(line)) { hits++; console.log(`${where}:${i + 1}: /${p.source}/`); }
  });
}
for (const subject of process.argv.includes('--history') ? git('log', '--all', '--format=%an %ae %cn %ce %B').toString('utf8').split('\n') : []) {
  for (const p of patterns) if (p.test(subject)) { hits++; console.log(`commit metadata: /${p.source}/`); }
}
console.log(hits ? `${hits} private match(es)` : `clean against ${patterns.length} patterns`);
process.exit(hits ? 1 : 0);

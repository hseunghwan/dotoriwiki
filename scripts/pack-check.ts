/**
 * Packs this checkout as npm publish would, installs the tarball into a temp prefix, and runs the
 * installed `dotoriwiki init` and `doctor` under a temp HOME with a stand-in claude. Nothing outside
 * the temp folder is written but npm's cache.
 *
 *   npm run check:pack
 */

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const work = await fs.mkdtemp(join(process.env.E2E_TMP ?? tmpdir(), 'dotoriwiki-pack-'));
const npm = (...args: string[]) => execFileSync('npm', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const [packed] = JSON.parse(npm('pack', '--json', '--pack-destination', work)) as [{ filename: string; files: { path: string }[] }];
const paths = packed.files.map((f) => f.path);
console.log(`packed ${packed.filename}: ${paths.length} files`);
assert.ok(paths.includes('dist/cli.js') && paths.includes('presets/en/dotoriwiki.yaml') && paths.includes('presets/ko/dotoriwiki.yaml'), 'the tarball holds dist and both presets');
assert.deepEqual(paths.filter((p) => /^(src|test|scripts|app|docs|plugin)\//.test(p) || p.endsWith('.ts')), [], 'the tarball holds no sources, tests, or app');

const prefix = join(work, 'prefix');
npm('install', '--global', '--prefix', prefix, '--prefer-offline', '--no-audit', '--no-fund', join(work, packed.filename));
const bin = join(prefix, 'bin', 'dotoriwiki');
console.log(`installed ${bin} -> ${await fs.realpath(bin)}`);

const claude = join(work, 'claude');
await fs.writeFile(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(work, 'home'), CLAUDE_BIN: claude, LANG: 'C' };
const run = (...args: string[]) => {
  const out = execFileSync(bin, args, { cwd: work, env, encoding: 'utf8' });
  console.log(`\n$ dotoriwiki ${args.join(' ')}\n${out.trimEnd()}`);
  return out;
};
assert.match(run('init', 'wiki', '--locale', 'en'), /^Created an English wiki at /);
assert.match(run('doctor'), /\nReady\.\n$/);
console.log(`\nok: ${work}`);

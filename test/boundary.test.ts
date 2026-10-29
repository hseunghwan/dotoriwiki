/**
 * Keeps wiki internals unreachable: a file in src/ or scripts/ outside src/wiki/ that imports
 * src/wiki/<anything but index.ts> fails the suite. That matters most for git.ts: a commit made
 * outside runNext would put lines in log.md that no transaction checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wikiDir = join(repo, 'src', 'wiki');

async function importsOutsideWiki(): Promise<{ from: string; to: string }[]> {
  const out: { from: string; to: string }[] = [];
  for (const top of ['src', 'scripts']) {
    const entries = await fs.readdir(join(repo, top), { recursive: true }).catch(() => [] as string[]);
    for (const rel of entries) {
      const file = join(repo, top, rel);
      if (!file.endsWith('.ts') || file.startsWith(`${wikiDir}/`)) continue;
      const text = await fs.readFile(file, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
        out.push({ from: relative(repo, file), to: relative(repo, resolve(dirname(file), m[1]!)) });
      }
    }
  }
  return out;
}

test('only src/wiki/index.ts is imported from outside src/wiki/', async () => {
  const imports = await importsOutsideWiki();
  assert.ok(imports.some((i) => i.from === 'src/main.ts' && i.to === 'src/wiki/index.ts'), 'the scan sees main.ts importing the wiki');
  const leaks = imports.filter((i) => i.to.startsWith('src/wiki/') && i.to !== 'src/wiki/index.ts');
  assert.deepEqual(leaks, []);
});

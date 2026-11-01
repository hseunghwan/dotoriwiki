import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');

test('the app carries the same wire contract as the gateway', () => {
  const gateway = readFileSync(join(repo, 'src/api.ts'), 'utf8');
  const app = readFileSync(join(repo, 'app/src/lib/wire.ts'), 'utf8');
  assert.ok(gateway === app, 'app/src/lib/wire.ts differs from src/api.ts. Edit src/api.ts, then run: cp src/api.ts app/src/lib/wire.ts');
});

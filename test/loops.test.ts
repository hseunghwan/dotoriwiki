import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FeedReport } from '../src/feeds.ts';
import { startLoops } from '../src/loops.ts';
import { fakeLlm, memo, open, tempWiki } from './helpers.ts';

test('the collector polls after firstMs, then every everyMs; a throwing poll is reported and polling goes on', async () => {
  const wiki = await open(await tempWiki(), fakeLlm());
  const started = Date.now();
  const polls: number[] = [];
  const reports: [string, unknown][] = [];
  const ok: FeedReport = { kind: 'polled', feed: 'geeknews', created: 1, duplicate: 0, skipped: [] };
  const loops = startLoops(wiki, {
    rescanMs: 60_000,
    backoffMs: 60_000,
    collector: {
      firstMs: 150,
      everyMs: 100,
      poll: async () => {
        polls.push(Date.now() - started);
        if (polls.length === 2) throw new Error('feed table broke');
        return [ok];
      },
    },
    onReport: (where, r) => reports.push([where, r]),
  });
  while (polls.length < 3) await new Promise((r) => setTimeout(r, 20));
  await loops.stop();
  const settled = polls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(polls.length, settled, 'no poll after stop');
  assert.ok(polls[0]! >= 140, `first poll waits firstMs (${polls[0]} ms)`);
  assert.ok(polls[1]! - polls[0]! >= 90, 'then every everyMs');
  const collector = reports.filter(([where]) => where === 'collector');
  assert.deepEqual(collector[0], ['collector', ok]);
  assert.match((collector[1]![1] as { message: string }).message, /feed table broke/);
  assert.deepEqual(collector[2], ['collector', ok], 'polling continues after a throw');
  await wiki.close();
});

test('a broken dotoriwiki.yaml is reported once; saving the fix wakes the loops, which route and ingest the memo that waited', async () => {
  const root = await tempWiki('en');
  const file = join(root, 'dotoriwiki.yaml');
  const good = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, good.replace('locale: en', 'locale: fr'));
  const llm = fakeLlm();
  llm.classifyWith = async () => ({ kind: 'classified', domain: 'learning', confidence: 0.9, reason: 'fake' });
  const wiki = await open(root, llm);
  const reports: [string, { kind: string }][] = [];
  const loops = startLoops(wiki, { rescanMs: 300, backoffMs: 60_000, collector: null, onReport: (where, r) => reports.push([where, r]) });
  try {
    await wiki.accept(memo(1));
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(reports.map(([where, r]) => `${where} ${r.kind}`), ['router paused'], 'reported once over several rescans');
    await fs.writeFile(file, good);
    for (let i = 0; i < 3000 && !reports.some(([where, r]) => where === 'worker learning' && r.kind === 'committed'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(reports.map(([where, r]) => `${where} ${r.kind}`), ['router paused', 'router routed', 'worker learning committed']);
  } finally {
    await loops.stop();
    await wiki.close();
  }
});

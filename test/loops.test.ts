import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedReport } from '../src/feeds.ts';
import { startLoops } from '../src/loops.ts';
import { fakeLlm, open, tempWiki } from './helpers.ts';

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

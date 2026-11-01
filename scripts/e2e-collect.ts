/**
 * End-to-end run of link enrichment and the feed collector, against a copy of the real wiki,
 * the real network, and the real `claude`:
 *
 *   node scripts/e2e-collect.ts [source wiki, default $WIKI_ROOT]
 *
 * Copies the wiki (without .gateway/, which belongs to the live gateway) into a temp dir,
 * opens it in-process with the shipped Llm and FetchSource, starts the loops with a collector
 * capped at 2 items per feed that polls once at start, and accepts one YouTube memo for
 * 미루기 아카이빙 and one article memo for the classifier to route. Waits until nothing is
 * pending, then prints the sidecars, the pages the run created, and the commits. The source
 * wiki is only read.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCli } from '../src/claude.ts';
import { execRun, sourceFetcher } from '../src/enrich.ts';
import { sipsShrink } from '../src/shrink.ts';
import { FEEDS, pollFeeds, type FeedReport } from '../src/feeds.ts';
import { DEFAULT_MODELS, routeLlm } from '../src/models.ts';
import { startLoops } from '../src/loops.ts';
import { isoWithOffset, openWiki, parseMemo, parseSourceFile } from '../src/wiki/index.ts';

const source = process.argv[2] ?? process.env.WIKI_ROOT;
if (!source) throw new Error('pass the source wiki as the first argument or set WIKI_ROOT');
const section = (title: string) => console.log(`\n━━━━ ${title} ━━━━`);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
const stamp = () => new Date().toISOString().slice(11, 19);

const work = await fs.mkdtemp(join(process.env.E2E_TMP ?? tmpdir(), 'dotoriwiki-e2e-collect-'));
const root = join(work, 'wiki');
await fs.cp(source, root, { recursive: true, filter: (p) => !p.startsWith(join(source, '.gateway')) });
const baseCommit = git(root, 'rev-parse', 'HEAD').trim();
section(`wiki copy at ${root} (base ${baseCommit.slice(0, 7)})`);

const claude = claudeCli({ bin: process.env.CLAUDE_BIN ?? 'claude', chat: DEFAULT_MODELS.chat, billing: { kind: 'subscription' } });
const llm = routeLlm(DEFAULT_MODELS, (c) => {
  if (c.provider !== 'claude') throw new Error('the defaults are all claude');
  return claude.llm(c);
});
const wiki = await openWiki(root, {
  llm,
  fetchSource: sourceFetcher({ http: fetch, run: execRun, ytDlp: process.env.YT_DLP_BIN ?? 'yt-dlp' }), shrinkPhoto: sipsShrink(execRun),
  maxAttempts: 3,
  reviewBelowConfidence: 0.6,
  ingestTimeoutMs: 10 * 60_000,
  committer: { name: 'dotoriwiki-gateway', email: 'gateway@localhost' },
  modelProfiles: ['default'],
});

const capped = Object.fromEntries(Object.entries(FEEDS).map(([name, feed]) => [name, { ...feed, cap: 2 }]));
let collected: readonly FeedReport[] | null = null;
const loops = startLoops(wiki, {
  rescanMs: 5_000,
  backoffMs: 10_000,
  collector: {
    poll: async () => (collected = await pollFeeds(capped, await wiki.config(), { http: fetch, accept: (m) => wiki.accept(m), now: () => new Date() })),
    firstMs: 0,
    everyMs: 24 * 3_600_000,
  },
  onReport: (where, r) => console.log(`[${stamp()}] ${where} ${JSON.stringify(r).slice(0, 400)}`),
});

const tz = (await wiki.config()).timeZone;
const memos = [
  { text: '이 영상 나중에 꼭 봐야지 https://youtu.be/0RCkKrm8Hgw', domain_hint: '미루기 아카이빙' },
  { text: 'UEFI 펌웨어 취약점 기사 https://arstechnica.com/security/2026/10/code-execution-flaw-in-uefi-firmware-threatens-most-servers-on-planet-earth/' },
];
try {
  section('accept two link memos');
  for (const m of memos) {
    const memo = parseMemo({ id: randomUUID(), captured_at: isoWithOffset(new Date(), tz), tz, source: 'share', ...m });
    if (!memo.ok) throw new Error(memo.detail);
    console.log(memo.value.id, m.text.slice(0, 40), '→', JSON.stringify(await wiki.accept(memo.value)));
  }

  section('waiting for the collector poll and for nothing pending');
  const started = Date.now();
  let last = '';
  for (;;) {
    const s = await wiki.status();
    const line = JSON.stringify(s);
    if (line !== last) console.log(`[${stamp()}] status ${line}`);
    last = line;
    if (collected && s.inbox === 0 && s.domains.every((d) => d.pending === 0 && d.running === null)) break;
    if (Date.now() - started > 40 * 60_000) throw new Error('timed out waiting for idle');
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log(`idle after ${Math.round((Date.now() - started) / 1000)}s`);

  section('collector poll');
  console.log(JSON.stringify(collected, null, 2));

  section('sidecars committed by this run');
  const sidecars = git(root, 'diff', '--name-only', `${baseCommit}..HEAD`, '--', '*/raw/*.source.md').trim().split('\n').filter(Boolean);
  for (const path of sidecars) {
    const text = git(root, 'show', `HEAD:${path}`);
    const parsed = parseSourceFile(text);
    console.log(`\n# ${path} (${text.length} chars)`);
    if (parsed.ok) for (const s of parsed.value.sources) console.log(`  ${s.kind} ${s.status} ${s.url} ${s.status === 'ok' ? `"${s.title}" ${s.text.length} chars` : s.detail}`);
    console.log(text.slice(0, 900).replace(/^/gm, '  | '));
  }

  section('pages created or changed by this run');
  const pages = git(root, 'diff', '--name-status', `${baseCommit}..HEAD`, '--', '*/wiki/**').trim();
  console.log(pages);
  const firstPage = pages.split('\n').map((l) => l.split('\t')[1]!).find((p) => p && !/\/(index|log|_review)\.md$/.test(p));
  if (firstPage) {
    section(`one page: ${firstPage}`);
    console.log(git(root, 'show', `HEAD:${firstPage}`));
  }

  section('commits');
  console.log(git(root, 'log', '--format=%h %s', `${baseCommit}..HEAD`));
  for (const d of (await wiki.config()).domains.keys()) {
    const lines = git(root, 'diff', `${baseCommit}..HEAD`, '--', `${d}/wiki/log.md`).split('\n').filter((l) => l.startsWith('+## ['));
    if (lines.length) console.log(`\n${d}/wiki/log.md\n${lines.join('\n')}`);
  }
  const review = git(root, 'diff', `${baseCommit}..HEAD`, '--', '*/wiki/_review.md').split('\n').filter((l) => l.startsWith('+- '));
  if (review.length) console.log(`\n_review.md additions\n${review.join('\n')}`);
} finally {
  claude.stopAll();
  await loops.stop();
  await wiki.close();
  console.log(`\ncopy kept at ${root}`);
}

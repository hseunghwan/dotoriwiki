import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDS, feedMemoId, pollFeeds, recent, type FeedPlan } from '../src/feeds.ts';
import { parseMemoFile } from '../src/wiki/pages.ts';
import { FEED_NAMES, parseMemoId, type DomainName, type NewMemo, type TimeZone } from '../src/wiki/index.ts';
import { editConfig, fakeLlm, listDir, open, readText, tempWiki } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'feeds');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
/** Shortly after the fixtures were fetched. */
const NOW = new Date('2026-10-28T17:00:00Z');
const ARTICLE = 'https://example.com/blog/2026/10/one-sqlite-queue/';

function feedHttp(over: (url: string) => Response | null = () => null) {
  const calls: string[] = [];
  const http = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const special = over(url);
    if (special) return special;
    if (url === 'https://news.hada.io/rss/news') return new Response(fixture('geeknews.xml'));
    if (url === 'https://news.hada.io/topic?id=36168') return new Response(fixture('geeknews-topic-36168.html'));
    if (url.startsWith('https://news.hada.io/topic?id=')) return new Response('<html><body>Ask GN 글</body></html>');
    if (url.startsWith('https://hn.algolia.com/')) return new Response(fixture('hackernews.json'));
    const sev = /severity=(\w+)/.exec(url)?.[1];
    if (url.startsWith('https://api.github.com/advisories') && sev) return new Response(fixture(`ghsa-${sev}.json`));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

const PLAN: FeedPlan = { locale: 'ko', timeZone: 'Asia/Seoul' as TimeZone, feeds: new Map(FEED_NAMES.map((n) => [n, { domain: 'news' as DomainName }])) };

function sink() {
  const memos: NewMemo[] = [];
  return { memos, accept: async (m: NewMemo) => (memos.push(m), { kind: 'created' as const }) };
}

test('feedMemoId: a UUID parseMemoId accepts, the same for the same item forever', () => {
  const id = feedMemoId('geeknews', '36168');
  assert.equal(id, 'e28f4e87-46f7-5748-900c-924e4d511163');
  assert.equal(parseMemoId(id), id);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(feedMemoId('geeknews', '36168'), id);
  assert.notEqual(feedMemoId('hackernews', '36168'), id);
  assert.notEqual(feedMemoId('geeknews', '36169'), id);
});

test('geeknews: Atom entries parse, and the article link comes from the topic page', () => {
  const items = FEEDS.geeknews.parse(fixture('geeknews.xml'));
  assert.equal(items.length, 20);
  const topic = items.find((i) => i.key === '36168')!;
  assert.equal(topic.title, '40개의 cron 작업을 SQLite 큐 하나로 대체한 이야기');
  assert.equal(topic.discussion, 'https://news.hada.io/topic?id=36168');
  assert.equal(topic.publishedAt.toISOString(), '2026-10-28T13:40:50.000Z');
  assert.match(topic.summary, /^- 예약 작업 40여 개를 각 서버의 cron에서 꺼내 SQLite 테이블 하나로 된 작업 큐로 옮긴 경험 공유\n- /);
  assert.equal(FEEDS.geeknews.linkFromDiscussion!(fixture('geeknews-topic-36168.html')), ARTICLE);
  assert.equal(FEEDS.geeknews.linkFromDiscussion!('<html>no link</html>'), null);
});

test('hackernews: hits parse with points; the query asks for points >= 300 in the last 36 h', () => {
  const [url] = FEEDS.hackernews.urls(NOW);
  const q = new URL(url!).searchParams;
  assert.equal(q.get('tags'), 'story');
  assert.equal(q.get('numericFilters'), `points>=300,created_at_i>=${NOW.getTime() / 1000 - 36 * 3600}`);
  const items = FEEDS.hackernews.parse(fixture('hackernews.json'));
  assert.equal(items.length, 12);
  assert.deepEqual(items[0], {
    key: '80000112',
    title: 'Lessons from running a 30-year-old mail server in a closet',
    link: 'https://example.com/posts/closet-mail-server',
    discussion: 'https://news.ycombinator.com/item?id=80000112',
    publishedAt: new Date('2026-10-28T12:49:45Z'),
    extra: [['points', '914']],
    summary: '',
  });
});

test('ghsa: one request per severity; advisories parse with CVE, severity, and packages', () => {
  assert.deepEqual(FEEDS.ghsa.urls(NOW).map((u) => new URL(u).searchParams.get('severity')), ['critical', 'high']);
  const items = FEEDS.ghsa.parse(fixture('ghsa-critical.json'));
  assert.equal(items.length, 6);
  const first = items[0]!;
  assert.equal(first.key, 'GHSA-7q2m-x9vc-4hrw');
  assert.equal(first.link, null);
  assert.equal(first.discussion, 'https://github.com/advisories/GHSA-7q2m-x9vc-4hrw');
  assert.deepEqual(first.extra, [['CVE', 'CVE-2026-990101'], ['severity', 'critical'], ['package', 'pip/example-hazelbox >= 2.4.0, < 2.6.1']]);
  assert.match(first.summary, /^## Summary\n\nHazelbox 2\.4\.0 introduced/);
});

test('recent: newest first, inside the window, at most cap', () => {
  const at = (h: number) => ({ key: String(h), title: '', link: null, discussion: null, extra: [], summary: '', publishedAt: new Date(NOW.getTime() - h * 3_600_000) });
  const items = [at(40), at(1), at(36), at(5), at(2), at(37)];
  assert.deepEqual(recent(items, NOW, 36 * 3_600_000, 3).map((i) => i.key), ['1', '2', '5']);
  assert.deepEqual(recent(items, NOW, 36 * 3_600_000, 10).map((i) => i.key), ['1', '2', '5', '36']);
});

test('a poll turns fixture responses into feed memos, capped per feed and windowed', async () => {
  const { http } = feedHttp();
  const out = sink();
  const reports = await pollFeeds(FEEDS, PLAN, { http, accept: out.accept, now: () => NOW });
  assert.deepEqual(reports.map((r) => [r.feed, r.kind, r.kind === 'polled' ? r.created : 0]), [['geeknews', 'polled', 15], ['hackernews', 'polled', 10], ['ghsa', 'polled', 15]]);
  assert.ok(out.memos.every((m) => m.source === 'feed' && m.domainHint === 'news' && m.tz === 'Asia/Seoul' && m.location === null));
  assert.ok(out.memos.every((m) => m.capturedAt.endsWith('+09:00')));

  const topic = out.memos.find((m) => m.id === feedMemoId('geeknews', '36168'))!;
  assert.equal(topic.capturedAt, '2026-10-28T22:40:50+09:00');
  assert.match(topic.text, new RegExp(`^\\[GeekNews\\] 40개의 cron 작업을 SQLite 큐 하나로 대체한 이야기\\n원문: ${ARTICLE.replace(/[.?]/g, '\\$&')}\\n게시: 2026-10-28\\n토론: https://news\\.hada\\.io/topic\\?id=36168\\n\\n- 예약 작업`));
  const ask = out.memos.find((m) => m.text.startsWith('[GeekNews]') && m.id !== topic.id)!;
  assert.match(ask.text, /\n원문: (https:\/\/news\.hada\.io\/topic\?id=\d+)\n게시: [^\n]+\n토론: \1\n/, 'no article link on the topic page: the topic is the original');

  const ghsa = out.memos.filter((m) => m.text.startsWith('[GHSA]'));
  const published = ghsa.map((m) => Date.parse(m.capturedAt));
  assert.ok(published.every((t) => t >= NOW.getTime() - 36 * 3_600_000), 'nothing older than 36 h');
  assert.deepEqual(published, [...published].sort((a, b) => b - a), 'newest first');
  assert.match(ghsa.find((m) => m.id === feedMemoId('ghsa', 'GHSA-7q2m-x9vc-4hrw'))!.text, /^\[GHSA\] Example Hazelbox [^\n]+\n게시: 2026-10-28\n토론: https:\/\/github\.com\/advisories\/GHSA-7q2m-x9vc-4hrw\nCVE: CVE-2026-990101\n심각도: critical\n패키지: pip\/example-hazelbox >= 2\.4\.0, < 2\.6\.1\n\n## Summary/);
  assert.match(out.memos.find((m) => m.text.startsWith('[Hacker News]'))!.text, /^\[Hacker News\] [^\n]+\n원문: https:[^\n]+\n게시: \d{4}-\d\d-\d\d\n토론: https:\/\/news\.ycombinator\.com\/item\?id=\d+\n점수: \d+$/);
});

test('a failing feed is reported and the others still poll; a topic page that fails skips only its item', async () => {
  const { http } = feedHttp((url) =>
    url.startsWith('https://hn.algolia.com/') ? new Response('down', { status: 503 })
      : url === 'https://news.hada.io/topic?id=36168' ? new Response('', { status: 500 }) : null);
  const out = sink();
  const reports = await pollFeeds(FEEDS, PLAN, { http, accept: out.accept, now: () => NOW });
  const hn = reports.find((r) => r.feed === 'hackernews')!;
  assert.equal(hn.kind, 'failed');
  assert.match(hn.kind === 'failed' ? hn.reason : '', /HTTP 503/);
  const gn = reports.find((r) => r.feed === 'geeknews')!;
  assert.deepEqual(gn.kind === 'polled' ? [gn.created, gn.skipped] : null, [14, ['36168: HTTP 500 from https://news.hada.io/topic?id=36168']]);
  assert.equal(reports.find((r) => r.feed === 'ghsa')!.kind, 'polled');
});

test('only the feeds the wiki names are polled, into their domain and stamped in the wiki time zone', async () => {
  const root = await tempWiki('en');
  await editConfig(root, (c) => ({ ...c, feeds: { hackernews: { domain: 'learning' } } }));
  const wiki = await open(root, fakeLlm());
  const { http, calls } = feedHttp();
  const out = sink();
  const reports = await pollFeeds(FEEDS, await wiki.config(), { http, accept: out.accept, now: () => NOW });
  assert.deepEqual(reports.map((r) => r.feed), ['hackernews']);
  assert.ok(calls.every((u) => u.startsWith('https://hn.algolia.com/')), 'no other feed is fetched');
  assert.ok(out.memos.length > 0 && out.memos.every((m) => m.domainHint === 'learning' && m.tz === 'America/Chicago' && /-0[56]:00$/.test(m.capturedAt)));
  assert.match(out.memos[0]!.text, /^\[Hacker News\] [^\n]+\nLink: https:[^\n]+\nPublished: \d{4}-\d\d-\d\d\nDiscussion: https:\/\/news\.ycombinator\.com\/item\?id=\d+\nPoints: \d+$/, 'labeled in the wiki locale');
  await wiki.close();
});

test('polling twice into a real Wiki inbox collects each item once', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  const feeds = { geeknews: { ...FEEDS.geeknews, cap: 3 }, ghsa: { ...FEEDS.ghsa, cap: 2 } };
  const ports = { http: feedHttp().http, accept: (m: NewMemo) => wiki.accept(m), now: () => NOW };
  const plan: FeedPlan = { ...(await wiki.config()), feeds: new Map([['geeknews', { domain: '스터디' as DomainName }], ['ghsa', { domain: '스터디' as DomainName }]]) };
  const first = await pollFeeds(feeds, plan, ports);
  assert.deepEqual(first.map((r) => (r.kind === 'polled' ? [r.created, r.duplicate] : r.kind)), [[3, 0], [2, 0]]);
  const inbox = (await listDir(join(root, 'inbox'))).filter((n) => n.endsWith('.md'));
  assert.equal(inbox.length, 5);
  const second = await pollFeeds(feeds, plan, { ...ports, now: () => new Date(NOW.getTime() + 3 * 3_600_000) });
  assert.deepEqual(second.map((r) => (r.kind === 'polled' ? [r.created, r.duplicate] : r.kind)), [[0, 3], [0, 2]]);
  assert.deepEqual((await listDir(join(root, 'inbox'))).filter((n) => n.endsWith('.md')), inbox);
  const parsed = parseMemoFile((await readText(join(root, 'inbox', inbox[0]!)))!);
  assert.ok(parsed.ok && parsed.value.memo.source === 'feed');
  await wiki.close();
});

/**
 * The feed collector: a table of news sources, each turned into memos for 개발소식지식베이스.
 * It keeps no state. Each poll reads a recent window, and the id of an item is a hash of its
 * feed and key, so `wiki.accept` dedup is what stops an item from being collected twice.
 */

import { createHash } from 'node:crypto';
import { decodeEntities, DESKTOP_UA } from './enrich.ts';
import { isoWithOffset, parseMemo, type AcceptResult, type Memo } from './wiki/index.ts';

const HOUR = 3_600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_CHARS = 8_000;
const TZ = 'Asia/Seoul';
const DOMAIN_HINT = '개발소식지식베이스';

export type FeedItem = {
  /** Stable for the life of the item; the memo id is derived from it. */
  readonly key: string;
  readonly title: string;
  /** The `원문:` line, the link enrichment fetches. null: none, or resolved from the discussion page. */
  readonly link: string | null;
  /** The `토론:` line, which enrichment skips. */
  readonly discussion: string | null;
  readonly publishedAt: Date;
  /** Fixed-label lines after `토론:`, such as `점수` or `CVE`. */
  readonly extra: readonly (readonly [label: string, value: string])[];
  readonly summary: string;
};

export type Feed = {
  /** Shown as `[label]` on the memo's first line. */
  readonly label: string;
  readonly windowMs: number;
  readonly cap: number;
  readonly urls: (now: Date) => readonly string[];
  readonly parse: (body: string) => readonly FeedItem[];
  /** For feeds whose entries point at their own discussion page: the article link found there. */
  readonly linkFromDiscussion?: (html: string) => string | null;
};

export type FeedName = 'geeknews' | 'hackernews' | 'ghsa';


const cdata = (s: string) => {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : decodeEntities(s);
};
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? cdata(m[1]!).trim() : '';
};

/** Feed HTML to plain text: list items become `- ` lines, paragraphs become lines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h\d|pre|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const day = (d: Date) => isoWithOffset(d, TZ).slice(0, 10);
const capText = (s: string) => (s.length <= SUMMARY_MAX_CHARS ? s : `${s.slice(0, SUMMARY_MAX_CHARS).trimEnd()}\n[…]`);

function geeknews(o: { windowMs: number; cap: number }): Feed {
  return {
    label: 'GeekNews',
    ...o,
    urls: () => ['https://news.hada.io/rss/news'],
    parse(xml) {
      const out: FeedItem[] = [];
      for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const topic = /<link[^>]*href=['"]([^'"]+)['"]/.exec(entry!)?.[1];
        const published = new Date(tag(entry!, 'published'));
        if (!topic || Number.isNaN(published.getTime())) continue;
        out.push({
          key: /[?&]id=(\d+)/.exec(topic)?.[1] ?? topic,
          title: tag(entry!, 'title'),
          link: null,
          discussion: topic,
          publishedAt: published,
          extra: [],
          summary: htmlToText(tag(entry!, 'content')),
        });
      }
      return out;
    },
    linkFromDiscussion: (html) => /<a\s+href=['"](https?:\/\/[^'"]+)['"][^>]*class=['"][^'"]*topic-title-link/.exec(html)?.[1] ?? null,
  };
}

function hackernews(o: { windowMs: number; cap: number; minPoints: number }): Feed {
  return {
    label: 'Hacker News',
    windowMs: o.windowMs,
    cap: o.cap,
    urls: (now) => {
      const since = Math.floor((now.getTime() - o.windowMs) / 1000);
      const q = new URLSearchParams({ tags: 'story', numericFilters: `points>=${o.minPoints},created_at_i>=${since}` });
      return [`https://hn.algolia.com/api/v1/search_by_date?${q}`];
    },
    parse(body) {
      const hits = (JSON.parse(body) as { hits?: Record<string, unknown>[] }).hits ?? [];
      return hits.flatMap((h): FeedItem[] => {
        if (typeof h.objectID !== 'string' || typeof h.title !== 'string' || typeof h.created_at_i !== 'number') return [];
        const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
        return [{
          key: h.objectID,
          title: h.title,
          link: typeof h.url === 'string' && h.url ? h.url : discussion,
          discussion,
          publishedAt: new Date(h.created_at_i * 1000),
          extra: [['점수', String(h.points ?? '')]],
          summary: typeof h.story_text === 'string' ? htmlToText(h.story_text) : '',
        }];
      });
    },
  };
}

type Advisory = {
  ghsa_id?: string;
  cve_id?: string | null;
  html_url?: string;
  summary?: string;
  description?: string | null;
  severity?: string;
  published_at?: string;
  vulnerabilities?: { package?: { ecosystem?: string; name?: string }; vulnerable_version_range?: string | null }[];
};

function ghsa(o: { windowMs: number; cap: number; severities: readonly string[] }): Feed {
  return {
    label: 'GHSA',
    windowMs: o.windowMs,
    cap: o.cap,
    // The API takes one severity per request.
    urls: () => o.severities.map((s) => `https://api.github.com/advisories?type=reviewed&severity=${s}&per_page=50&sort=published&direction=desc`),
    parse(body) {
      return (JSON.parse(body) as Advisory[]).flatMap((a): FeedItem[] => {
        if (!a.ghsa_id || !a.html_url || !a.published_at) return [];
        const packages = (a.vulnerabilities ?? []).map((v) => `${v.package?.ecosystem ?? '?'}/${v.package?.name ?? '?'} ${v.vulnerable_version_range ?? ''}`.trim());
        return [{
          key: a.ghsa_id,
          title: a.summary ?? a.ghsa_id,
          link: null,
          discussion: a.html_url,
          publishedAt: new Date(a.published_at),
          extra: [
            ...(a.cve_id ? [['CVE', a.cve_id] as const] : []),
            ['심각도', a.severity ?? ''],
            ...packages.map((p) => ['패키지', p] as const),
          ],
          summary: capText((a.description ?? '').trim()),
        }];
      });
    },
  };
}

export const FEEDS: { readonly [N in FeedName]: Feed } = {
  geeknews: geeknews({ windowMs: 36 * HOUR, cap: 15 }),
  hackernews: hackernews({ windowMs: 36 * HOUR, cap: 10, minPoints: 300 }),
  ghsa: ghsa({ windowMs: 36 * HOUR, cap: 15, severities: ['critical', 'high'] }),
};


/** UUID-formatted SHA-1 of `<feed>:<key>`, version 5 and RFC 4122 variant, so parseMemoId accepts it. */
export function feedMemoId(feed: string, key: string): string {
  const h = createHash('sha1').update(`${feed}:${key}`).digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function renderFeedMemo(label: string, item: FeedItem): string {
  const head = [
    `[${label}] ${item.title}`,
    ...(item.link ? [`원문: ${item.link}`] : []),
    `게시: ${day(item.publishedAt)}`,
    ...(item.discussion ? [`토론: ${item.discussion}`] : []),
    ...item.extra.map(([k, v]) => `${k}: ${v}`),
  ];
  return item.summary ? `${head.join('\n')}\n\n${item.summary}` : head.join('\n');
}

/** Newest first, inside the window, at most `cap`. */
export function recent(items: readonly FeedItem[], now: Date, windowMs: number, cap: number): readonly FeedItem[] {
  const since = now.getTime() - windowMs;
  return items.filter((i) => i.publishedAt.getTime() >= since).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).slice(0, cap);
}


export type CollectPorts = {
  readonly http: typeof fetch;
  readonly accept: (memo: Memo) => Promise<AcceptResult>;
  readonly now: () => Date;
};

export type FeedReport =
  | { readonly kind: 'polled'; readonly feed: string; readonly created: number; readonly duplicate: number; readonly skipped: readonly string[] }
  | { readonly kind: 'failed'; readonly feed: string; readonly reason: string };

async function get(http: typeof fetch, url: string): Promise<string> {
  const res = await http(url, { headers: { 'user-agent': DESKTOP_UA, accept: '*/*' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.text();
}

async function pollFeed(name: string, feed: Feed, ports: CollectPorts): Promise<FeedReport> {
  const now = ports.now();
  const items: FeedItem[] = [];
  for (const url of feed.urls(now)) items.push(...feed.parse(await get(ports.http, url)));
  let created = 0;
  let duplicate = 0;
  const skipped: string[] = [];
  for (const item of recent(items, now, feed.windowMs, feed.cap)) {
    let link = item.link;
    if (link === null && feed.linkFromDiscussion && item.discussion) {
      const page = await get(ports.http, item.discussion).catch((e: unknown) => e as Error);
      if (page instanceof Error) {
        skipped.push(`${item.key}: ${page.message}`);
        continue;
      }
      link = feed.linkFromDiscussion(page) ?? item.discussion;
    }
    const memo = parseMemo({
      id: feedMemoId(name, item.key),
      text: renderFeedMemo(feed.label, { ...item, link }),
      captured_at: isoWithOffset(item.publishedAt, TZ),
      tz: TZ,
      source: 'feed',
      domain_hint: DOMAIN_HINT,
    });
    if (!memo.ok) {
      skipped.push(`${item.key}: ${memo.detail}`);
      continue;
    }
    if ((await ports.accept(memo.value)).kind === 'created') created++;
    else duplicate++;
  }
  return { kind: 'polled', feed: name, created, duplicate, skipped };
}

/** Feeds run side by side; one that throws or times out is reported and never stops the rest. */
export function pollFeeds(feeds: Readonly<Record<string, Feed>>, ports: CollectPorts): Promise<readonly FeedReport[]> {
  return Promise.all(
    Object.entries(feeds).map(([name, feed]) =>
      pollFeed(name, feed, ports).catch((e: unknown): FeedReport => ({ kind: 'failed', feed: name, reason: (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message })),
    ),
  );
}

/**
 * The enrichment sidecar `<d>/raw/<id>.source.md`: which links in a memo get fetched, and the
 * file that records what came back. Pure, like pages.ts. Fetching is the FetchSource port's job.
 */

import { splitFrontmatter, withFrontmatter, type Parsed } from './pages.ts';
import type { FetchedSource, MemoId, MemoSource, SourceKind } from './index.ts';

export const MAX_SOURCES = 3;
export const MAX_SOURCE_CHARS = 30_000;

export type SourceEntry = { readonly url: string } & FetchedSource;
export type SourceFile = { readonly memo: MemoId; readonly fetchedAt: string; readonly sources: readonly SourceEntry[] };

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\]]+/g;

function trimUrl(raw: string): string | null {
  let url = raw.replace(/[.,;:!?]+$/, '');
  while (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/**
 * The first MAX_SOURCES distinct links, in order of appearance. A `토론:` line names a discussion
 * page whose content is already in the memo. A feed memo is fetched only by its `원문:` line, so
 * links inside a feed's summary (an advisory's references) are not.
 */
export function linksToFetch(memoText: string, source: MemoSource): readonly string[] {
  const out: string[] = [];
  for (const line of memoText.split('\n')) {
    if (/^\s*토론\s*:/.test(line) || (source === 'feed' && !/^원문:/.test(line))) continue;
    for (const m of line.matchAll(URL_IN_TEXT)) {
      const url = trimUrl(m[0]);
      if (url && !out.includes(url)) out.push(url);
    }
  }
  return out.slice(0, MAX_SOURCES);
}

const cap = (text: string) => {
  const t = text.trim();
  return t.length <= MAX_SOURCE_CHARS ? t : `${t.slice(0, MAX_SOURCE_CHARS).trimEnd()}\n\n[… ${t.length}자 중 ${MAX_SOURCE_CHARS}자까지만 실음]`;
};

const bodyOf = (s: SourceEntry) => (s.status === 'ok' ? cap(s.text) : `수집 실패: ${s.detail}`);

export function renderSourceFile(f: SourceFile): string {
  return withFrontmatter(
    {
      memo: f.memo,
      fetched_at: f.fetchedAt,
      sources: f.sources.map((s) => ({
        url: s.url,
        kind: s.kind,
        status: s.status,
        title: s.title,
        detail: s.status === 'failed' ? s.detail : null,
      })),
    },
    f.sources.map((s) => `\n## ${s.url}\n\n${bodyOf(s)}\n`).join(''),
  );
}

const KINDS: readonly SourceKind[] = ['video', 'article'];

/** Texts come back as written: capped, trimmed. */
export function parseSourceFile(text: string): Parsed<SourceFile> {
  const { data, body, error } = splitFrontmatter(text);
  if (!data) return { ok: false, detail: error ?? 'no frontmatter' };
  if (typeof data.memo !== 'string' || typeof data.fetched_at !== 'string' || !Array.isArray(data.sources)) {
    return { ok: false, detail: 'memo, fetched_at, sources required' };
  }
  const list = data.sources.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s));
  if (list.length !== data.sources.length) return { ok: false, detail: 'sources: expected a list of mappings' };
  const sources: SourceEntry[] = [];
  let at = 0;
  const heads = list.map((s) => `\n## ${String(s.url)}\n`);
  for (const [i, raw] of list.entries()) {
    const { url, kind, status, title, detail } = raw;
    if (typeof url !== 'string' || !KINDS.includes(kind as SourceKind)) return { ok: false, detail: `sources[${i}]: url and kind required` };
    const start = body.indexOf(heads[i]!, at);
    if (start < 0) return { ok: false, detail: `no section for ${url}` };
    const from = start + heads[i]!.length;
    const next = i + 1 < heads.length ? body.indexOf(heads[i + 1]!, from) : -1;
    at = next < 0 ? body.length : next;
    const section = body.slice(from, at).trim();
    const k = kind as SourceKind;
    if (status === 'ok' && typeof title === 'string') sources.push({ url, kind: k, status, title, text: section });
    else if (status === 'failed' && typeof detail === 'string') sources.push({ url, kind: k, status, title: typeof title === 'string' ? title : null, detail });
    else return { ok: false, detail: `sources[${i}]: bad status` };
  }
  return { ok: true, value: { memo: data.memo as MemoId, fetchedAt: data.fetched_at, sources } };
}

/** `2026-10-29T10:00:00+09:00` in the given zone, the shape captured_at uses. */
export function isoWithOffset(at: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName!.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

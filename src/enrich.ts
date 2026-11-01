/**
 * The FetchSource port: turns one link into plain text for raw/<id>.source.md. Videos go through
 * `yt-dlp -J` for metadata and the caption track URL; everything else is an article read with
 * Readability. Network and subprocess calls come in as ports so tests run offline.
 */

import { execFile } from 'node:child_process';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { textFor, type FetchedSource, type FetchSource, type SourceKind, type Text } from './wiki/index.ts';

export type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
/** argv is passed straight to the binary, never through a shell. */
export type Run = (bin: string, argv: readonly string[], timeoutMs: number) => Promise<RunResult>;
export type EnrichPorts = { readonly http: typeof fetch; readonly run: Run; readonly ytDlp: string };

export const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ARTICLE_TIMEOUT_MS = 15_000;
const ARTICLE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 90_000;

export const execRun: Run = (bin, argv, timeoutMs) =>
  new Promise((done) => {
    execFile(bin, [...argv], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      done({ code, stdout, stderr: err && code === null ? `${stderr}\n${err.message}` : stderr });
    });
  });

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

export function kindOf(url: string): SourceKind {
  return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase()) ? 'video' : 'article';
}

const failed = (kind: SourceKind, detail: string, title: string | null = null): FetchedSource => ({ kind, status: 'failed', title, detail });

/** Adding a SourceKind without a fetcher fails type-checking. */
const FETCHERS: { readonly [K in SourceKind]: (url: string, ports: EnrichPorts, t: Text) => Promise<FetchedSource> } = {
  video: fetchVideo,
  article: fetchArticle,
};

function describeError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'timed out';
  const cause = err?.cause?.code ?? err?.cause?.message;
  return `${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`;
}

export function sourceFetcher(ports: EnrichPorts): FetchSource {
  return async (url, locale) => {
    const kind = kindOf(url);
    try {
      return await FETCHERS[kind](url, ports, textFor(locale));
    } catch (e) {
      return failed(kind, describeError(e));
    }
  };
}


type Track = { readonly ext?: string; readonly url?: string };
type VideoInfo = {
  readonly title?: string;
  readonly channel?: string;
  readonly uploader?: string;
  readonly duration_string?: string;
  readonly upload_date?: string;
  readonly description?: string;
  readonly language?: string | null;
  readonly subtitles?: Record<string, readonly Track[]>;
  readonly automatic_captions?: Record<string, readonly Track[]>;
};

/**
 * Manual captions beat auto captions; within each, `langs` in order. Auto tracks other than the
 * spoken language (`-orig`) are machine translations, so they are not picked.
 */
export function pickSubtitle(info: VideoInfo, langs: readonly string[]): { readonly lang: string; readonly auto: boolean; readonly url: string } | null {
  const vtt = (tracks: readonly Track[] | undefined) => tracks?.find((t) => t.ext === 'vtt' && typeof t.url === 'string')?.url;
  const manual = info.subtitles ?? {};
  for (const lang of langs) {
    const key = Object.keys(manual).find((k) => k === lang || k.startsWith(`${lang}-`));
    const url = key ? vtt(manual[key]) : undefined;
    if (url) return { lang, auto: false, url };
  }
  const auto = info.automatic_captions ?? {};
  for (const lang of langs) {
    const url = vtt(auto[`${lang}-orig`]) ?? (info.language === lang ? vtt(auto[lang]) : undefined);
    if (url) return { lang, auto: true, url };
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/**
 * Cue text only, tags and timings dropped. Auto captions roll: each line shows up again at the
 * top of the next cue or two, so a line equal to one of the last two kept lines is dropped.
 */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    for (const raw of lines.slice(timing + 1)) {
      const line = decodeEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      if (line && !out.slice(-2).includes(line)) out.push(line);
    }
  }
  return out.join('\n');
}

const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';
const day = (yyyymmdd: string | undefined) => (yyyymmdd && /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : '');

async function fetchVideo(url: string, ports: EnrichPorts, t: Text): Promise<FetchedSource> {
  const r = await ports.run(ports.ytDlp, ['-J', '--skip-download', '--no-playlist', '--no-warnings', '--', url], VIDEO_TIMEOUT_MS);
  if (r.code !== 0) return failed('video', `yt-dlp exited ${r.code ?? 'by signal'}: ${lastLine(r.stderr)}`);
  let info: VideoInfo;
  try {
    info = JSON.parse(r.stdout) as VideoInfo;
  } catch {
    return failed('video', 'yt-dlp printed no JSON');
  }
  const s = t.sidecar;
  const track = pickSubtitle(info, t.captionLanguages);
  let captions = s.noCaptions;
  if (track) {
    const res = await ports.http(track.url, { headers: { 'user-agent': DESKTOP_UA }, signal: AbortSignal.timeout(ARTICLE_TIMEOUT_MS) }).catch((e: unknown) => describeError(e));
    if (typeof res === 'string') captions = s.captionsFailed(res);
    else if (!res.ok) captions = s.captionsFailed(`HTTP ${res.status}`);
    else captions = `${s.captions(track.lang, track.auto)}\n${vttToText(await res.text())}`;
  }
  const title = info.title ?? '';
  const text = [
    `${s.title}: ${title}`,
    `${s.channel}: ${info.channel ?? info.uploader ?? ''}`,
    `${s.length}: ${info.duration_string ?? ''}`,
    `${s.published}: ${day(info.upload_date)}`,
    '',
    `${s.description}:`,
    (info.description ?? '').trim(),
    '',
    captions,
  ].join('\n');
  return { kind: 'video', status: 'ok', title, text };
}


async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!res.body) return new Uint8Array();
  // Leaving the loop early cancels the stream, so the rest is never downloaded.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const tidy = (text: string) => text.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

export function readableText(html: string): { readonly title: string; readonly text: string } | null {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = tidy(article?.textContent ?? '');
  return text ? { title: (article?.title ?? '').trim(), text } : null;
}

async function fetchArticle(url: string, ports: EnrichPorts, t: Text): Promise<FetchedSource> {
  const res = await ports.http(url, {
    headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': t.acceptLanguage },
    redirect: 'follow',
    signal: AbortSignal.timeout(ARTICLE_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return failed('article', `HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return failed('article', `not HTML: ${type || 'no content type'}`);
  }
  const bytes = await readCapped(res, ARTICLE_MAX_BYTES);
  if (!bytes) return failed('article', 'body over 5 MB');
  const article = readableText(decode(bytes, type));
  return article ? { kind: 'article', status: 'ok', title: article.title, text: article.text } : failed('article', 'no readable text');
}

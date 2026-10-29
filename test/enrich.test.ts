import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindOf, pickSubtitle, sourceFetcher, vttToText, type EnrichPorts, type Run } from '../src/enrich.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'enrich');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const VIDEO = 'https://youtu.be/dotoriWiki0';

function ports(over: { http?: (url: string) => Response | Promise<Response>; run?: Run } = {}) {
  const calls = { http: [] as string[], run: [] as (readonly string[])[] };
  const p: EnrichPorts = {
    ytDlp: 'yt-dlp',
    http: (async (input: string | URL | Request) => {
      calls.http.push(String(input));
      if (!over.http) throw new Error(`unexpected GET ${String(input)}`);
      return over.http(String(input));
    }) as typeof fetch,
    run: async (bin, argv, timeoutMs) => {
      calls.run.push([bin, ...argv]);
      return over.run ? over.run(bin, argv, timeoutMs) : { code: 0, stdout: fixture('youtube.json'), stderr: '' };
    },
  };
  return { p, calls };
}

const html = (body: string, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

test('vttToText: real auto captions come out as each spoken line once, no timings or tags', () => {
  const raw = fixture('youtube.ko-orig.vtt');
  const text = vttToText(raw);
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['안녕하세요, 여러분. 도토리랩', '한서윤입니다. 오늘은 예약 작업을', 'SQLite 테이블 하나로 관리하는 방법을', '이야기해 보려고 합니다. 서버가']);
  assert.ok(lines.every((l, i) => l !== lines[i - 1] && l !== lines[i - 2]), 'no line repeats its neighbours');
  assert.doesNotMatch(text, /-->|<c>|<\d\d:|WEBVTT|align:start/);
  assert.ok(text.length < raw.length / 3, `rolling duplicates removed (${text.length} of ${raw.length})`);
});

test('vttToText: manual captions keep every cue and decode entities', () => {
  const vtt = 'WEBVTT\n\nNOTE 메모\n\n1\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry\n\n2\n00:00:02.000 --> 00:00:03.000\n<v Speaker>둘째 줄</v>\n';
  assert.equal(vttToText(vtt), 'Tom & Jerry\n둘째 줄');
});

test('pickSubtitle: manual over auto, Korean over English, no machine-translated auto tracks', () => {
  const t = (name: string) => [{ ext: 'json3', url: `${name}.json3` }, { ext: 'vtt', url: `${name}.vtt` }];
  assert.deepEqual(pickSubtitle({ subtitles: { en: t('m-en'), 'ko-KR': t('m-ko') }, automatic_captions: { 'ko-orig': t('a-ko') } }), { lang: 'ko', auto: false, url: 'm-ko.vtt' });
  assert.deepEqual(pickSubtitle({ subtitles: { en: t('m-en') }, automatic_captions: { 'ko-orig': t('a-ko') } }), { lang: 'en', auto: false, url: 'm-en.vtt' });
  assert.deepEqual(pickSubtitle({ language: 'en', automatic_captions: { ko: t('a-ko-translated'), 'en-orig': t('a-en') } }), { lang: 'en', auto: true, url: 'a-en.vtt' });
  assert.equal(pickSubtitle({ language: 'en', automatic_captions: { ko: t('a-ko-translated') } }), null);
  assert.equal(pickSubtitle({}), null);
});

test('kindOf: YouTube hosts are videos, everything else is an article', () => {
  assert.equal(kindOf('https://youtu.be/x'), 'video');
  assert.equal(kindOf('https://www.youtube.com/watch?v=x'), 'video');
  assert.equal(kindOf('https://m.youtube.com/watch?v=x'), 'video');
  assert.equal(kindOf('https://example.com/youtube.com'), 'article');
});

test('video: metadata from yt-dlp -J, captions fetched from the picked track', async () => {
  const { p, calls } = ports({ http: () => new Response(fixture('youtube.ko-orig.vtt'), { headers: { 'content-type': 'text/vtt' } }) });
  const r = await sourceFetcher(p)(VIDEO);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.kind, 'video');
  assert.equal(r.title, 'SQLite 하나로 만드는 작업 큐: cron 40개를 정리한 방법');
  assert.match(r.text, /^제목: SQLite 하나로 만드는 작업 큐[^\n]*\n채널: 도토리랩\n길이: 1:19\n게시: 2026-03-08\n\n설명:\n/);
  assert.match(r.text, /\n자막 \(ko, 자동\):\n안녕하세요, 여러분\. 도토리랩\n한서윤입니다\./);
  assert.equal(calls.run.length, 1);
  assert.deepEqual(calls.run[0]!.slice(-2), ['--', VIDEO], 'the link is passed as one argv element after --');
  assert.ok(calls.run[0]!.includes('--skip-download'));
  assert.match(calls.http[0]!, /^https:\/\/www\.youtube\.com\/api\/timedtext\?.*lang=ko/);
});

test('video: no captions, or captions that fail to download, still make an ok source', async () => {
  const noSubs = ports({ run: async () => ({ code: 0, stdout: JSON.stringify({ ...JSON.parse(fixture('youtube.json')), automatic_captions: {} }), stderr: '' }) });
  const r1 = await sourceFetcher(noSubs.p)(VIDEO);
  assert.equal(r1.status, 'ok');
  assert.match(r1.status === 'ok' ? r1.text : '', /\n자막: 없음$/);
  assert.equal(noSubs.calls.http.length, 0);

  const limited = ports({ http: () => new Response('slow down', { status: 429 }) });
  const r2 = await sourceFetcher(limited.p)(VIDEO);
  assert.equal(r2.status, 'ok');
  assert.match(r2.status === 'ok' ? r2.text : '', /\n자막: 받지 못함 \(HTTP 429\)$/);
});

test('video: a yt-dlp failure is a failed source with its last stderr line', async () => {
  const { p } = ports({ run: async () => ({ code: 1, stdout: '', stderr: 'WARNING: x\nERROR: [youtube] abc: Video unavailable\n' }) });
  assert.deepEqual(await sourceFetcher(p)(VIDEO), { kind: 'video', status: 'failed', title: null, detail: 'yt-dlp exited 1: ERROR: [youtube] abc: Video unavailable' });
});

test('article: a real page comes back as readable main text', async () => {
  const { p } = ports({ http: () => html(fixture('article.html')) });
  const r = await sourceFetcher(p)('https://example.com/blog/2026/10/one-sqlite-queue/');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.kind, 'article');
  assert.equal(r.title, 'We replaced 40 cron jobs with one SQLite queue');
  assert.match(r.text, /The queue lives in a single table, and every worker claims a row with one UPDATE \.\.\. RETURNING statement\./);
  assert.doesNotMatch(r.text, /<\/?(p|div|script)\b|\n{3,}/);
});

test('article: non-HTML, HTTP errors, oversized bodies, and timeouts are failed sources', async () => {
  const fetchWith = (http: () => Response | Promise<Response>) => sourceFetcher(ports({ http }).p)('https://example.com/a');
  assert.deepEqual(await fetchWith(() => html('%PDF-1.7', 'application/pdf')), { kind: 'article', status: 'failed', title: null, detail: 'not HTML: application/pdf' });
  assert.deepEqual(await fetchWith(() => html('nope', 'text/html', 404)), { kind: 'article', status: 'failed', title: null, detail: 'HTTP 404' });
  const big = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
    },
  });
  assert.deepEqual(await fetchWith(() => new Response(big, { headers: { 'content-type': 'text/html' } })), { kind: 'article', status: 'failed', title: null, detail: 'body over 5 MB' });
  assert.deepEqual(await fetchWith(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))), { kind: 'article', status: 'failed', title: null, detail: 'timed out' });
});

test('article: EUC-KR pages declared in a meta tag decode to Korean', async () => {
  const body = Buffer.concat([
    Buffer.from('<html><head><meta charset="euc-kr"><title>t</title></head><body><article><p>'),
    Buffer.from(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb])),
    Buffer.from(` ${'filler text. '.repeat(60)}`),
    Buffer.from('</p></article></body></html>'),
  ]);
  const { p } = ports({ http: () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  const r = await sourceFetcher(p)('https://example.co.kr/');
  assert.equal(r.status, 'ok');
  assert.match(r.status === 'ok' ? r.text : '', /^한글/);
});

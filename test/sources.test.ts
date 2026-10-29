import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWithOffset, parseSourceFile, type MemoId, type SourceFile } from '../src/wiki/index.ts';
import { linksToFetch, renderSourceFile } from '../src/wiki/sources.ts';

test('linksToFetch: first three distinct links in order, trailing punctuation and markdown parens dropped', () => {
  const text = [
    '이거 봐야지 https://youtu.be/abc.',
    '[글](https://example.com/a_(b)) 그리고 https://example.com/x?y=1,',
    'https://youtu.be/abc 다시',
    'https://four.example/ 넷째',
  ].join('\n');
  assert.deepEqual(linksToFetch(text, 'typed'), ['https://youtu.be/abc', 'https://example.com/a_(b)', 'https://example.com/x?y=1']);
});

test('linksToFetch: URLs on 토론: lines are skipped', () => {
  const text = '[GeekNews] 제목\n원문: https://arstechnica.com/a\n게시: 2026-10-28\n토론: https://news.hada.io/topic?id=1\n\n요약';
  assert.deepEqual(linksToFetch(text, 'share'), ['https://arstechnica.com/a']);
  assert.deepEqual(linksToFetch('링크 없는 메모', 'typed'), []);
});

test('linksToFetch: a feed memo is fetched only by its 원문: line', () => {
  const gn = '[GeekNews] 제목\n원문: https://arstechnica.com/a\n게시: 2026-10-28\n토론: https://news.hada.io/topic?id=1\n\n- 요약 속 링크 https://other.example/b';
  assert.deepEqual(linksToFetch(gn, 'feed'), ['https://arstechnica.com/a']);
  const ghsa = '[GHSA] x\n게시: 2026-10-28\n토론: https://github.com/advisories/GHSA-1\n\nFixed by [PR](https://github.com/o/r/pull/1)';
  assert.deepEqual(linksToFetch(ghsa, 'feed'), []);
});

test('sidecar render then parse returns the sources, with long text capped behind a visible marker', () => {
  const long = '가'.repeat(30_500);
  const file: SourceFile = {
    memo: '0f1e2d3c-0000-5000-8000-000000000001' as MemoId,
    fetchedAt: '2026-10-29T10:00:00+09:00',
    sources: [
      { url: 'https://youtu.be/abc', kind: 'video', status: 'ok', title: '제목: "따옴표"', text: '제목: 영상\n\n## 설명처럼 보이는 줄\n본문' },
      { url: 'https://example.com/a.pdf', kind: 'article', status: 'failed', title: null, detail: 'not HTML: application/pdf' },
      { url: 'https://example.com/long', kind: 'article', status: 'ok', title: '긴 글', text: long },
    ],
  };
  const text = renderSourceFile(file);
  assert.match(text, /^---\nmemo: 0f1e2d3c-0000-5000-8000-000000000001\nfetched_at: "?2026-10-29T10:00:00\+09:00"?\n/);
  assert.match(text, /\n## https:\/\/example.com\/a.pdf\n\n수집 실패: not HTML: application\/pdf\n/);
  const parsed = parseSourceFile(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.detail);
  const [video, pdf, capped] = parsed.value.sources;
  assert.deepEqual(video, file.sources[0]);
  assert.deepEqual(pdf, file.sources[1]);
  assert.equal(capped!.status, 'ok');
  if (capped!.status !== 'ok') return;
  assert.ok(capped!.text.startsWith('가'.repeat(30_000)), 'first 30,000 characters kept');
  assert.ok(!capped!.text.includes('가'.repeat(30_001)), 'nothing past the cap');
  assert.match(capped!.text, /\[… 30500자 중 30000자까지만 실음\]$/);
  assert.equal(parsed.value.fetchedAt, file.fetchedAt);
});

test('isoWithOffset writes local wall time with the zone offset', () => {
  assert.equal(isoWithOffset(new Date('2026-10-29T01:00:00Z'), 'Asia/Seoul'), '2026-10-29T10:00:00+09:00');
  assert.equal(isoWithOffset(new Date('2026-10-28T15:30:05Z'), 'Asia/Seoul'), '2026-10-29T00:30:05+09:00');
  assert.equal(isoWithOffset(new Date('2026-10-29T01:00:00Z'), 'UTC'), '2026-10-29T01:00:00+00:00');
});

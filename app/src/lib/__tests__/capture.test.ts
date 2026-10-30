import { buildMemoRequest, formatCapturedAt } from '../capture';

const at = new Date('2026-10-29T06:12:03.456Z');

describe('formatCapturedAt', () => {
  it.each([
    [540, '2026-10-29T15:12:03+09:00'],
    [0, '2026-10-29T06:12:03+00:00'],
    [-300, '2026-10-29T01:12:03-05:00'],
    [-210, '2026-10-29T02:42:03-03:30'],
    [345, '2026-10-29T11:57:03+05:45'],
    [-480, '2026-10-28T22:12:03-08:00'],
  ])('offset %i → %s', (offset, expected) => {
    expect(formatCapturedAt(at, offset)).toBe(expected);
  });

  it('matches the gateway rule: ISO-8601 with an offset that parses to the same instant', () => {
    const s = formatCapturedAt(at, 540);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(s)).toBe(Math.floor(at.getTime() / 1000) * 1000);
  });
});

it('builds the MemoRequest once with the phone offset and time zone', () => {
  const req = buildMemoRequest({
    id: '0d4e8c3a-1b2c-4d5e-8f90-123456789abc',
    text: '오늘 RAG 청크 크기 512로 바꾸니 검색 정확도 올라감',
    at,
    source: 'typed',
    domainHint: '스터디',
    location: { lat: 37.54, lon: 127.05, place: '성동구 성수동2가', address: '서울특별시 성동구 성수동2가 273-5' },
    attachments: [],
  });
  expect(req).toEqual({
    id: '0d4e8c3a-1b2c-4d5e-8f90-123456789abc',
    text: '오늘 RAG 청크 크기 512로 바꾸니 검색 정확도 올라감',
    captured_at: '2026-10-29T15:12:03+09:00',
    tz: 'Asia/Seoul',
    location: { lat: 37.54, lon: 127.05, place: '성동구 성수동2가', address: '서울특별시 성동구 성수동2가 273-5' },
    source: 'typed',
    domain_hint: '스터디',
  });
});

it('adds attachments only when the memo has photos, and lets the text be empty', () => {
  const req = buildMemoRequest({
    id: 'x', text: '', at, source: 'typed', domainHint: null, location: null,
    attachments: [{ n: 1, origin: 'gallery', place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' }],
  });
  expect(req.text).toBe('');
  expect(req.attachments).toEqual([{ n: 1, origin: 'gallery', place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' }]);
});

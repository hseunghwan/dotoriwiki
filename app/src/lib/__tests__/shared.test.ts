import { memoText, parseShared, preview } from '../shared';

it('accepts only share and selection with some text', () => {
  expect(parseShared({ source: 'share', text: ' https://youtu.be/abc ', subject: '에이전트 설계 강의' })).toEqual({ source: 'share', text: 'https://youtu.be/abc', subject: '에이전트 설계 강의', photos: [] });
  expect(parseShared({ source: 'selection', text: '염려하지 말라' })).toEqual({ source: 'selection', text: '염려하지 말라', subject: null, photos: [] });
  expect(parseShared({ source: 'typed', text: 'x' })).toBeNull();
  expect(parseShared({ source: 'share', text: '   ' })).toBeNull();
});

it('takes shared photos with or without text, file URIs only, at most 10', () => {
  const a = 'file:///data/user/0/dev.dotoriwiki.app/files/outbox/pending/a.jpg';
  expect(parseShared({ source: 'share', photos: JSON.stringify([a]) })).toEqual({ source: 'share', text: '', subject: null, photos: [a] });
  expect(parseShared({ source: 'share', text: '여기', photos: JSON.stringify([a, 'content://media/1', '/etc/passwd', 3]) })?.photos).toEqual([a]);
  expect(parseShared({ source: 'share', photos: JSON.stringify(Array.from({ length: 12 }, () => a)) })?.photos).toHaveLength(10);
  expect(parseShared({ source: 'share', photos: 'not json' })).toBeNull();
  expect(parseShared({ source: 'selection', photos: JSON.stringify([a]) })).toBeNull();
});

it('previews a shared link by title and host', () => {
  expect(preview({ source: 'share', text: 'https://www.youtube.com/watch?v=1', subject: '에이전트 설계 강의' })).toEqual({ kind: 'link', title: '에이전트 설계 강의', host: 'youtube.com' });
  expect(preview({ source: 'share', text: '이거 좋다 https://news.hada.io/topic?id=1', subject: null })).toEqual({ kind: 'link', title: '이거 좋다', host: 'news.hada.io' });
  expect(preview({ source: 'selection', text: '염려하지 말라', subject: null })).toEqual({ kind: 'text', text: '염려하지 말라' });
});

it('keeps the share title the text lacks, then the note', () => {
  const s = { source: 'share' as const, text: 'https://youtu.be/abc', subject: '에이전트 설계 강의' };
  expect(memoText(s, ' 주말에 보기 ')).toBe('에이전트 설계 강의\nhttps://youtu.be/abc\n주말에 보기');
  expect(memoText({ ...s, text: '에이전트 설계 강의 https://youtu.be/abc' }, '')).toBe('에이전트 설계 강의 https://youtu.be/abc');
  expect(memoText({ source: 'share', text: '', subject: null }, ' 한강 ')).toBe('한강');
  expect(memoText({ source: 'share', text: '', subject: null }, '')).toBe('');
});

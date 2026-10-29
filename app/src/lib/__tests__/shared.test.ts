import { memoText, parseShared, preview } from '../shared';

it('accepts only share and selection with some text', () => {
  expect(parseShared({ source: 'share', text: ' https://youtu.be/abc ', subject: '에이전트 설계 강의' })).toEqual({ source: 'share', text: 'https://youtu.be/abc', subject: '에이전트 설계 강의' });
  expect(parseShared({ source: 'selection', text: '염려하지 말라' })).toEqual({ source: 'selection', text: '염려하지 말라', subject: null });
  expect(parseShared({ source: 'typed', text: 'x' })).toBeNull();
  expect(parseShared({ source: 'share', text: '   ' })).toBeNull();
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
});

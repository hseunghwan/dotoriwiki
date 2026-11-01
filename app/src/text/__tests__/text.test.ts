import { COPY, localeFor, type Copy } from '..';
import { verdictText } from '../../lib/memos';
import type { MemoListItemWire } from '../../lib/wire';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const DAY = new Date('2026-10-29T14:40:00+09:00');

/** Sample arguments for every function in the table. A function with no entry fails the walk. */
const ARGS: Record<string, unknown[][]> = {
  'time.clock': [[DAY], [new Date('2026-10-29T00:05:00+09:00')]],
  'time.monthDay': [[DAY]],
  'time.dateTime': [[DAY]],
  'time.otherYear': [[DAY]],
  'failure.brokenLink': [['RAG tuning']],
  'failure.allBlocked': [[3]],
  'failure.retrying': [[2]],
  'failure.tried': [[1], [2]],
  'network.timeout': [[8]],
  'network.photo': [[2, 'HTTP 500']],
  'onboarding.steps': [[1, 3]],
  'onboarding.found': [[1], [4]],
  'memoTab.reconnect': [[2]],
  'memoTab.offline': [[2]],
  'photos.nth': [[1, 'Chicago'], [2, null]],
  'photos.remove': [[1]],
  'photos.count': [[1], [3]],
  'photos.attachN': [[2]],
  'activity.counts': [[1, 2]],
  'activity.heldFallback': [['learning']],
  'activity.heldGuess': [['learning', 'Sounds like study notes'], ['learning', '']],
  'detail.filedTo': [['learning']],
  'detail.movedTo': [['learning']],
  'detail.parked': [['inbox']],
  'detail.probably': [['learning']],
  'detail.sure': [[true], [false]],
  'detail.more': [['broken-link x.md']],
  'detail.moving': [['learning']],
  'detail.rawKept': [['learning']],
  'detail.confirm': [['learning']],
  'move.moving': [['learning']],
  'chat.savedTo': [['learning']],
  'chat.askDomain': [['learning']],
  'chat.rememberedIn': [['learning']],
  'chats.turns': [[1], [5]],
  'chats.remove': [['RAG question']],
  'settings.unsent': [[1], [2]],
  'settings.rejected': [[1], [2]],
};

/** Every entry as [path, kind], walking objects and arrays. */
function shape(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string' || typeof value === 'function') return [[path, typeof value]];
  if (Array.isArray(value)) return [[path, 'array']];
  return Object.entries(value as object).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
}

/** Every sentence the table can produce, functions run with ARGS. */
function sentences(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => sentences(v, path));
  if (typeof value === 'function') {
    const args = ARGS[path];
    if (!args) throw new Error(`no sample arguments for ${path}`);
    return args.map((a) => (value as (...a: unknown[]) => string)(...a));
  }
  return Object.entries(value as object).flatMap(([k, v]) => sentences(v, path ? `${path}.${k}` : k));
}

/** The text module and memos.ts as a phone with this language tag loads them. */
function loadAs(tag: string): { copy: Copy; locale: string; memos: typeof import('../../lib/memos') } {
  let loaded!: ReturnType<typeof loadAs>;
  jest.requireMock<{ deviceTag: jest.Mock }>('../device').deviceTag.mockReturnValueOnce(tag);
  jest.isolateModules(() => {
    const text = require('..') as typeof import('..');
    loaded = { copy: text.copy, locale: text.locale, memos: require('../../lib/memos') };
  });
  return loaded;
}

describe('locale', () => {
  it.each([
    ['ko-KR', 'ko'], ['ko', 'ko'], ['ko_KR', 'ko'], ['KO-kr', 'ko'], ['ko-Kore-KR', 'ko'],
    ['en-US', 'en'], ['en-GB', 'en'], ['ja-JP', 'en'], ['kok-IN', 'en'], ['', 'en'], [undefined, 'en'],
  ])('%s shows %s', (tag, locale) => {
    expect(localeFor(tag)).toBe(locale);
  });

  it('follows the phone language at startup', () => {
    expect(loadAs('en-US').locale).toBe('en');
    expect(loadAs('en-US').copy.tabs.chat).toBe('Ask');
    expect(loadAs('ko-KR').locale).toBe('ko');
    expect(loadAs('ko-KR').copy.tabs.chat).toBe('질문');
    expect(loadAs('fr-FR').copy.tabs.chat).toBe('Ask');
  });
});

describe('tables', () => {
  it('ko and en have the same keys, each of the same kind', () => {
    expect(shape(COPY.en)).toEqual(shape(COPY.ko));
  });

  it('every function has sample arguments, and no sample is left over', () => {
    expect(shape(COPY.ko).filter(([, kind]) => kind === 'function').map(([p]) => p).sort()).toEqual(Object.keys(ARGS).sort());
  });

  it('en has no Hangul in any sentence', () => {
    const korean = sentences(COPY.en).filter((s) => HANGUL.test(s));
    expect(korean).toEqual([]);
  });

  it('en counts in singular and plural', () => {
    expect(COPY.en.photos.count(1)).toBe('1 photo');
    expect(COPY.en.photos.count(3)).toBe('3 photos');
    expect(COPY.en.failure.tried(2)).toBe('2 tries');
  });

  it('en tells the time in 12 hours with AM and PM', () => {
    const { memos } = loadAs('en-US');
    const now = new Date('2026-10-29T15:12:30+09:00');
    expect(memos.recentTime(new Date('2026-10-29T15:12:00+09:00'), now)).toBe('Just now');
    expect(memos.recentTime(new Date('2026-10-29T14:40:00+09:00'), now)).toBe('2:40 PM');
    expect(memos.recentTime(new Date('2026-10-29T00:05:00+09:00'), now)).toBe('12:05 AM');
    expect(memos.recentTime(new Date('2026-10-28T11:20:00+09:00'), now)).toBe('Oct 28, 11:20 AM');
    expect(memos.dayLabel(new Date('2025-12-31T09:00:00+09:00'), now)).toBe('Dec 31, 2025');
  });
});

describe('verdict', () => {
  type V = Pick<MemoListItemWire, 'verdict' | 'verdict_id'>;
  const fromEnglishWiki: V = { verdict: 'new page', verdict_id: 'created' };
  const fromKoreanWiki: V = { verdict: '기존 페이지 수정', verdict_id: 'updated' };
  const beforeTheGateway: V = { verdict: '기존 내용과 충돌', verdict_id: null };
  const olderGateway: V = { verdict: '새 페이지' };
  const newerId = { verdict: 'merged', verdict_id: 'merged' } as unknown as V;

  it('words verdict_id in the phone language, whatever language the wiki writes', () => {
    expect(verdictText(fromEnglishWiki)).toBe('새 페이지');
    expect(loadAs('en-US').memos.verdictText(fromKoreanWiki)).toBe('Updated page');
    expect(loadAs('en-US').memos.verdictText({ verdict: '저장', verdict_id: 'saved' })).toBe('Saved');
  });

  it('shows the wire text when verdict_id is null, absent, or unknown', () => {
    for (const memos of [loadAs('ko-KR').memos, loadAs('en-US').memos]) {
      expect(memos.verdictText(beforeTheGateway)).toBe('기존 내용과 충돌');
      expect(memos.verdictText(olderGateway)).toBe('새 페이지');
      expect(memos.verdictText(newerId)).toBe('merged');
      expect(memos.verdictText({ verdict: null, verdict_id: null })).toBeNull();
    }
  });

  it('reaches the recent memo rows', () => {
    const item: MemoListItemWire = {
      id: 'a', text: 'x', captured_at: '2026-10-29T15:00:00+09:00', tz: 'Asia/Seoul', source: 'typed', domain: 'learning', state: 'ingested',
      verdict: '새 페이지', verdict_id: 'created', first_page: 'RAG', finished_at: '2026-10-29T15:02:00+09:00', photos: 0,
    };
    expect(loadAs('en-US').memos.mergeRecent([], [item])[0]!.verdict).toBe('New page');
  });
});

import { addressOf, placeOf } from '../location';

const none = { district: null, subregion: null, city: null, region: null, street: null, streetNumber: null, name: null, formattedAddress: null };

describe('placeOf', () => {
  it('joins the 구 and the 동', () => {
    expect(placeOf({ ...none, region: '서울특별시', district: '종로구', street: '사직동', streetNumber: '123-45', formattedAddress: '대한민국 서울특별시 종로구 사직동 123-45' })).toBe('종로구 사직동');
  });

  it('finds the 동 in the address when the street is a road', () => {
    expect(placeOf({ ...none, district: '성동구', street: '왕십리로', formattedAddress: '대한민국 서울특별시 성동구 성수동2가 왕십리로 83-21' })).toBe('성동구 성수동2가');
  });

  it.each([['사직1동'], ['을지로3가'], ['진접읍'], ['서면']])('takes %s as a 동', (dong) => {
    expect(placeOf({ ...none, district: '어딘가', street: dong })).toBe(`어딘가 ${dong}`);
  });

  it('skips roads and apartment blocks, keeping just the 구', () => {
    expect(placeOf({ ...none, district: '종로구', street: '사직로', formattedAddress: '대한민국 서울특별시 종로구 사직로 247 101동' })).toBe('종로구');
  });

  it('falls back to the wider area, or null', () => {
    expect(placeOf({ ...none, city: '서울특별시' })).toBe('서울특별시');
    expect(placeOf(none)).toBeNull();
  });
});

describe('addressOf', () => {
  it('keeps the full address without the country', () => {
    expect(addressOf({ ...none, name: '123-45', formattedAddress: '대한민국 서울특별시 종로구 사직동 123-45' })).toBe('서울특별시 종로구 사직동 123-45');
  });

  it('adds a building name the address leaves out', () => {
    expect(addressOf({ ...none, name: '서울시청', formattedAddress: '대한민국 서울특별시 중구 세종대로 110' })).toBe('서울특별시 중구 세종대로 110 (서울시청)');
  });

  it('builds one from the parts when there is no formatted address', () => {
    expect(addressOf({ ...none, region: '서울특별시', district: '종로구', street: '사직동', streetNumber: '123-45' })).toBe('서울특별시 종로구 사직동 123-45');
    expect(addressOf(none)).toBeNull();
  });
});

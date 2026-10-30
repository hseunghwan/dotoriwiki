import { addPhotos, attachmentsOf, canSend, MAX_PHOTOS, outboxName, photoCount, type DraftPhoto } from '../photos';

const photo = (name: string, origin: DraftPhoto['origin'] = 'gallery'): DraftPhoto => ({ uri: `file:///files/outbox/pending/${name}.jpg`, origin, place: null, address: null });

it('numbers attachments in strip order from 1', () => {
  const photos = [{ ...photo('a'), place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' }, photo('b', 'camera'), photo('c', 'share')];
  expect(attachmentsOf(photos)).toEqual([
    { n: 1, origin: 'gallery', place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' },
    { n: 2, origin: 'camera', place: null, address: null },
    { n: 3, origin: 'share', place: null, address: null },
  ]);
  expect(attachmentsOf(photos.filter((p) => p.uri !== photos[1]!.uri)).map((a) => a.n)).toEqual([1, 2]);
});

it('sends text, photos, or both, but not nothing', () => {
  expect(canSend('  ', [])).toBe(false);
  expect(canSend('', [photo('a')])).toBe(true);
  expect(canSend('메모', [])).toBe(true);
});

it('caps the strip at ten and reports the rest', () => {
  const nine = Array.from({ length: 9 }, (_, i) => photo(`p${i}`));
  const { photos, dropped } = addPhotos(nine, [photo('x'), photo('y')]);
  expect(photos).toHaveLength(MAX_PHOTOS);
  expect(photos.at(-1)?.uri).toContain('/x.jpg');
  expect(dropped.map((p) => p.uri)).toEqual([photo('y').uri]);
});

it('names the outbox copy by memo id and n, keeping the extension', () => {
  expect(outboxName('m1', 2, 'file:///files/outbox/pending/ab.HEIC')).toBe('m1-2.heic');
  expect(outboxName('m1', 1, 'file:///files/outbox/pending/noext')).toBe('m1-1.jpg');
});

it('counts the photos a frozen body carries', () => {
  expect(photoCount({ attachments: [{}, {}] })).toBe(2);
  expect(photoCount({ attachments: null })).toBe(0);
  expect(photoCount({})).toBe(0);
});

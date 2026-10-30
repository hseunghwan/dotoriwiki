import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { photoFacts, photoLocation, sniffPhoto, takenAtOf, withEmbeds, withoutEmbeds, type Attachment } from '../src/wiki/photos.ts';
import { parseMemoFile, renderMemoFile } from '../src/wiki/pages.ts';
import type { EditRequest, EditResult, Memo, MemoId } from '../src/wiki/index.ts';
import { GALAXY, jpegWithExif, PLAIN_JPEG } from './exif.ts';
import {
  fakeLlm, headFile, ledgerLines, listDir, memo, modelWrites, open, page, rawIdOf, readText, serveHttp, tempWiki, TOKEN, ulid, validFields,
} from './helpers.ts';

const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };

test('photo facts: when, where and on what, read from the bytes with the date left in its own offset', async () => {
  const f = await photoFacts(jpegWithExif(GALAXY), 'Asia/Seoul');
  assert.equal(f.takenAt, '2026-10-12T14:03:22+09:00');
  assert.deepEqual(f.gps, { lat: 37.57591, lon: 126.96877 });
  assert.deepEqual(f.device, { make: 'samsung', model: 'SM-S928N', lens: 'Galaxy S24 Ultra Rear Wide Camera', software: 'S928NXXU1AXA1' });
  assert.deepEqual(f.camera, { exposure: '1/120', fNumber: 1.7, iso: 50, focal35mm: 23, flash: false });

  const bare = await photoFacts(PLAIN_JPEG, 'Asia/Seoul');
  assert.deepEqual([bare.takenAt, bare.gps, bare.device, bare.camera], [null, null, null, null], 'a photo without EXIF has no metadata, not made-up metadata');
  assert.deepEqual(await photoFacts(Buffer.from('not an image'), 'Asia/Seoul').then((x) => x.gps), null, 'garbage does not throw');
});

test('taken_at: a missing offset tag takes the memo zone, a missing date is null, never the file time', () => {
  assert.equal(takenAtOf('2026:10:12 14:03:22', null, 'Asia/Seoul'), '2026-10-12T14:03:22+09:00');
  assert.equal(takenAtOf('2026:07:01 09:00:00', null, 'Europe/Paris'), '2026-07-01T09:00:00+02:00');
  assert.equal(takenAtOf('0000:00:00 00:00:00', null, 'Asia/Seoul'), null);
  assert.equal(takenAtOf(null, '+09:00', 'Asia/Seoul'), null);
});

test('photo location: its own GPS, else the memo fix only for a camera shot taken just now', () => {
  const gps = { lat: 37.57591, lon: 126.96877 };
  const req = (origin: 'gallery' | 'camera' | 'share') => ({ n: 1, origin, place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' });
  assert.deepEqual(photoLocation(gps, req('gallery'), SEOUL), { ...gps, place: '종로구 사직동', address: '서울특별시 종로구 사직동 1', from: 'exif' });
  assert.deepEqual(photoLocation(null, req('camera'), SEOUL), { ...SEOUL, from: 'device' });
  assert.equal(photoLocation(null, req('gallery'), SEOUL), null, 'an old gallery photo is not where the memo was written');
  assert.equal(photoLocation(null, req('share'), SEOUL), null);
  assert.equal(photoLocation(null, req('camera'), null), null);
});

test('sniffing trusts magic bytes only', () => {
  assert.equal(sniffPhoto(PLAIN_JPEG), 'jpg');
  assert.equal(sniffPhoto(Buffer.from('\x89PNG\r\n\x1a\n....', 'latin1')), 'png');
  assert.equal(sniffPhoto(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(sniffPhoto(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1')), 'heic');
  assert.equal(sniffPhoto(Buffer.from('<html>', 'latin1')), null);
});

const attachment = (file: string): Attachment => ({
  file, original: file.replace('.jpg', '.heic'), sha256: 'ab', bytes: 1, width: null, height: null, origin: 'gallery', takenAt: null, location: null, device: null, camera: null,
});

test('embeds: appended after the text Obsidian-style, and only that trailing run is taken back off', () => {
  const as = [attachment('a-1.jpg'), attachment('a-2.jpg')];
  assert.equal(withEmbeds('놀이터', as), '놀이터\n\n![[a-1.jpg]]\n![[a-2.jpg]]');
  assert.equal(withEmbeds('', as), '![[a-1.jpg]]\n![[a-2.jpg]]');
  for (const text of ['놀이터', '', '본문에 ![[a-1.jpg]] 직접 적음', '끝\n\n![[a-1.jpg]]']) {
    assert.equal(withoutEmbeds(withEmbeds(text, as), as), text);
  }
});

test('the memo file round-trips its photos: frontmatter record, embeds in the body, typed text unchanged', () => {
  const m: Memo = { ...memo(1, '-'), text: '', attachments: [{ ...attachment(`${ulid(1)}-1.jpg`), takenAt: '2026-10-12T14:03:22+09:00', location: { lat: 1, lon: 2, place: 'p', address: null, from: 'exif' } }] };
  const file = renderMemoFile(m, null);
  assert.match(file, new RegExp(`\\n---\\n!\\[\\[${ulid(1)}-1\\.jpg\\]\\]\\n$`), 'a photo-only memo body is just the embed');
  assert.match(file, /taken_at: 2026-10-12T14:03:22\+09:00/);
  const back = parseMemoFile(file);
  assert.ok(back.ok);
  assert.equal(back.value.memo.text, '');
  assert.deepEqual(back.value.memo.attachments, m.attachments);
});

/** Uploads photo n of memo `id` the way PUT /attachments does, then returns the request entry for it. */
async function upload(wiki: Awaited<ReturnType<typeof open>>, id: string, n: number, bytes: Buffer, origin: 'gallery' | 'camera' | 'share' = 'gallery') {
  const r = await wiki.storePhoto(id as MemoId, n, bytes);
  assert.equal(r.kind, 'stored');
  return { n, origin, place: origin === 'gallery' ? '종로구 사직동' : null, address: null };
}

test('storePhoto: same bytes again are free, other bytes conflict, non-images are refused, originals stay out of git', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  const id = ulid(1) as MemoId;
  const jpeg = jpegWithExif(GALAXY);
  assert.deepEqual(await wiki.storePhoto(id, 1, jpeg).then((r) => r.kind), 'stored');
  assert.deepEqual(await wiki.storePhoto(id, 1, jpeg).then((r) => r.kind), 'same');
  assert.deepEqual(await wiki.storePhoto(id, 1, PLAIN_JPEG).then((r) => r.kind), 'conflict');
  assert.deepEqual(await wiki.storePhoto(id, 2, Buffer.from('<html>')), { kind: 'unsupported' });
  assert.deepEqual(await listDir(join(root, '_originals')), [`${id}-1.jpg`]);
  assert.deepEqual(await listDir(join(root, '_attachments')), [`${id}-1.jpg`], 'the copy is made at upload');
  await wiki.close();
});

test('a copy that cannot be made refuses the upload, so the phone stops resending it', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm(), { shrinkPhoto: async () => { throw new Error('sips: cannot read'); } });
  assert.deepEqual(await wiki.storePhoto(ulid(1) as MemoId, 1, PLAIN_JPEG), { kind: 'unsupported' });
  assert.deepEqual(await listDir(join(root, '_originals')), [], 'the unreadable original is not kept');
  await wiki.close();
});

test('accept: photos must be uploaded first; their metadata lands in the frontmatter and the classifier sees it as text', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const id = ulid(1);
  assert.deepEqual(await wiki.accept(memo(1, '친구랑 놀이터', { attachments: [{ n: 1, origin: 'gallery' }] })), { kind: 'missing-photo', n: 1 });
  assert.deepEqual(await listDir(join(root, 'inbox')), [], 'nothing is written for a memo whose photo is missing');

  const a1 = await upload(wiki, id, 1, jpegWithExif(GALAXY));
  const a2 = await upload(wiki, id, 2, PLAIN_JPEG, 'camera');
  assert.deepEqual(await wiki.accept(memo(1, '친구랑 놀이터', { attachments: [a1, a2], location: SEOUL })), { kind: 'created' });
  const parsed = parseMemoFile((await readText(join(root, 'inbox', `${id}.md`)))!);
  assert.ok(parsed.ok);
  const [p1, p2] = parsed.value.memo.attachments;
  assert.equal(parsed.value.memo.text, '친구랑 놀이터');
  assert.deepEqual(
    { file: p1!.file, original: p1!.original, takenAt: p1!.takenAt, location: p1!.location, model: p1!.device?.model },
    { file: `${id}-1.jpg`, original: `${id}-1.jpg`, takenAt: '2026-10-12T14:03:22+09:00', location: { lat: 37.57591, lon: 126.96877, place: '종로구 사직동', address: null, from: 'exif' }, model: 'SM-S928N' },
  );
  assert.deepEqual(p2!.location, { ...SEOUL, from: 'device' }, 'a camera shot without GPS takes the memo fix');

  assert.equal((await wiki.routeNext()).kind, 'routed');
  assert.match(llm.classifyCalls[0]!.text, /친구랑 놀이터\n\n사진 1: 2026-10-12 14:03, 종로구 사직동, samsung SM-S928N\n사진 2: 중구 태평로1가/);
  await wiki.close();
});

test('a photo-only memo is accepted; an empty memo without photos still is not', async () => {
  const root = await tempWiki();
  const wiki = await open(root, fakeLlm());
  assert.throws(() => memo(1, ''), /text: required/);
  const a = await upload(wiki, ulid(2), 1, PLAIN_JPEG);
  assert.deepEqual(await wiki.accept(memo(2, '', { attachments: [a] })), { kind: 'created' });
  await wiki.close();
});

test('ingest: the copies are job inputs the model is shown, may be embedded, and are committed with the pages', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  const id = ulid(1);
  const a = await upload(wiki, id, 1, jpegWithExif(GALAXY));
  await wiki.accept(memo(1, '놀이터', { attachments: [a], domain_hint: '스터디' }));
  await wiki.routeNext();
  llm.editWith = async (req: EditRequest): Promise<EditResult> => {
    await modelWrites(req, `wiki/놀이터.md`, page(validFields(rawIdOf(req)), `미끄럼틀을 탔다.\n\n![[${id}-1.jpg]]\n`));
    return { kind: 'finished', verdict: '새 페이지', pages: [] };
  };
  const report = await wiki.runNext('스터디' as never);
  assert.equal(report.kind, 'committed', ledgerLines(root, '스터디').at(-1));
  const req = llm.editCalls[0]!;
  assert.deepEqual(req.images, [join(await fs.realpath(root), '_attachments', `${id}-1.jpg`)]);
  assert.match(req.prompt, /사진 1장이 붙어 있다[\s\S]*사진 1: 2026-10-12 14:03, 종로구 사직동, samsung SM-S928N/);
  assert.ok(headFile(root, `_attachments/${id}-1.jpg`) !== null, 'the copy is committed');
  assert.equal(headFile(root, `_originals/${id}-1.jpg`), null, 'the original never is');
  await wiki.close();
});

test('check: a page may embed only a photo that exists in _attachments', async () => {
  const root = await tempWiki();
  const llm = fakeLlm();
  const wiki = await open(root, llm);
  await wiki.accept(memo(1, '그림', { domain_hint: '일상' }));
  await wiki.routeNext();
  llm.editWith = async (req) => {
    await modelWrites(req, 'wiki/그림.md', page(validFields(rawIdOf(req)), '![[없는사진.jpg]]\n'));
    return { kind: 'finished', verdict: '새 페이지', pages: [] };
  };
  assert.equal((await wiki.runNext('일상' as never)).kind, 'retrying');
  assert.match(ledgerLines(root, '일상').at(-1)!, /broken-link .*\[\[없는사진\.jpg\]\] does not resolve/);
  await wiki.close();
});

test('openWiki refuses a vault whose .gitignore would let originals into git', async () => {
  const root = await tempWiki();
  await fs.rm(join(root, '.gitignore'));
  await assert.rejects(open(root, fakeLlm()), /_originals\/ must be listed in the wiki \.gitignore/);
});

test('uploads abandoned for a week are swept at start; a memo\'s photos and recent uploads are kept', async () => {
  const root = await tempWiki();
  let wiki = await open(root, fakeLlm());
  const kept = await upload(wiki, ulid(1), 1, PLAIN_JPEG);
  await wiki.accept(memo(1, '남는 메모', { attachments: [kept] }));
  await upload(wiki, ulid(2), 1, PLAIN_JPEG);
  await upload(wiki, ulid(3), 1, PLAIN_JPEG);
  await wiki.close();
  const old = new Date('2026-10-01T00:00:00Z');
  for (const id of [ulid(1), ulid(2)]) await fs.utimes(join(root, '_originals', `${id}-1.jpg`), old, old);
  wiki = await open(root, fakeLlm(), { now: () => new Date('2026-10-29T00:00:00Z') });
  assert.deepEqual(await listDir(join(root, '_originals')), [`${ulid(1)}-1.jpg`, `${ulid(3)}-1.jpg`]);
  assert.deepEqual(await listDir(join(root, '_attachments')), [`${ulid(1)}-1.jpg`, `${ulid(3)}-1.jpg`]);
  await wiki.close();
});

test('HTTP: PUT then POST, the list counts photos, the detail describes them, GET serves the copy', async () => {
  const s = await serveHttp();
  const id = '3f1d2c4b-5a69-4e7f-8a1b-2c3d4e5f6a7b';
  const put = (path: string, body: Uint8Array) =>
    fetch(`${s.base}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/jpeg' }, body: new Uint8Array(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const jpeg = jpegWithExif(GALAXY);
  assert.equal((await put(`/attachments/${id}/1`, jpeg)).status, 201);
  assert.equal((await put(`/attachments/${id}/1`, jpeg)).status, 200, 'a resend is free');
  assert.equal((await put(`/attachments/${id}/1`, PLAIN_JPEG)).status, 409);
  assert.equal((await put(`/attachments/${id}/2`, Buffer.from('<html>'))).status, 400);
  assert.equal((await put(`/attachments/${id}/11`, jpeg)).status, 400);

  const body = { id, text: '', captured_at: '2026-10-29T08:10:00+09:00', tz: 'Asia/Seoul', source: 'typed', domain_hint: '일상' };
  assert.deepEqual(await s.call('POST', '/memos', { ...body, attachments: [{ n: 1, origin: 'gallery', place: '종로구 사직동' }, { n: 2, origin: 'camera' }] }), {
    status: 422, body: { error: 'unprocessable', detail: 'attachments: photo 2 was not uploaded' },
  });
  assert.equal((await s.call('POST', '/memos', { ...body, attachments: [{ n: 1, origin: 'gallery', place: '종로구 사직동' }] })).status, 201);

  const list = await s.call('GET', '/memos');
  assert.equal(list.body.memos[0].photos, 1);
  const detail = await s.call('GET', `/memos/${id}`);
  assert.deepEqual(detail.body.attachments, [{ file: `${id}-1.jpg`, taken_at: '2026-10-12T14:03:22+09:00', place: '종로구 사직동', device: 'samsung SM-S928N' }]);

  const img = await fetch(`${s.base}/attachments/${id}-1.jpg`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg, 'the fake shrink copies, so the bytes match');
  assert.equal((await s.call('GET', `/attachments/${id}-1.heic`)).status, 404, 'originals are never served');
  assert.equal((await s.call('GET', '/attachments/..%2Finbox')).status, 404);
  assert.equal((await fetch(`${s.base}/attachments/${id}-1.jpg`)).status, 401);
  await s.close();
});

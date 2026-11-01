/**
 * Photos on memos: what the gateway reads out of an original's bytes, and how the result sits in
 * the memo file. Pure apart from parsing a buffer, like sources.ts. Storing bytes and making the
 * 2048 px copy are index.ts's job.
 *
 *   _originals/<id>-<n>.<ext>    the bytes the phone sent, never committed
 *   _attachments/<id>-<n>.jpg    the copy pages embed with ![[...]], committed with the ingest
 */

import { createHash } from 'node:crypto';
import exifr from 'exifr';
import type { GeoPoint, MemoId } from './index.ts';
import type { Parsed } from './pages.ts';
import type { Text } from './text.ts';

export const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const PHOTO_ORIGINS = ['gallery', 'camera', 'share'] as const;
export type PhotoOrigin = (typeof PHOTO_ORIGINS)[number];
export type PhotoExt = 'jpg' | 'png' | 'webp' | 'heic';

/** What the phone says about photo n: where it came from, and the geocoded name of its own GPS fix. */
export type AttachmentRequest = { readonly n: number; readonly origin: PhotoOrigin; readonly place: string | null; readonly address: string | null };

/** `from: device` is the memo's own fix, used for a camera photo that carried no GPS. */
export type PhotoLocation = GeoPoint & { readonly from: 'exif' | 'device' };
export type PhotoDevice = { readonly make: string | null; readonly model: string | null; readonly lens: string | null; readonly software: string | null };
export type PhotoCamera = {
  readonly exposure: string | null;
  readonly fNumber: number | null;
  readonly iso: number | null;
  readonly focal35mm: number | null;
  readonly flash: boolean | null;
};

/** One photo as recorded in the memo frontmatter. Everything but `origin` and the place names comes from the original's bytes. */
export type Attachment = {
  readonly file: string;
  readonly original: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly origin: PhotoOrigin;
  readonly takenAt: string | null;
  readonly location: PhotoLocation | null;
  readonly device: PhotoDevice | null;
  readonly camera: PhotoCamera | null;
};

export const photoStem = (id: MemoId, n: number) => `${id}-${n}`;
export const attachmentName = (id: MemoId, n: number) => `${photoStem(id, n)}.jpg`;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|avif)$/i;
export const isImageLink = (target: string) => IMAGE_EXT.test(target);

/** The type from magic bytes. The phone's Content-Type is not trusted. */
export function sniffPhoto(b: Uint8Array): PhotoExt | null {
  const ascii = (from: number, to: number) => Buffer.from(b.subarray(from, to)).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(8, 12))) return 'heic';
  return null;
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The tags read, as exifr names them with values left raw, so dates are never shifted into the Mac's zone. */
type Tags = {
  Make?: string; Model?: string; Software?: string; LensModel?: string; Orientation?: number;
  DateTimeOriginal?: string; OffsetTimeOriginal?: string;
  ExposureTime?: number; FNumber?: number; ISO?: number; FocalLengthIn35mmFormat?: number; Flash?: number;
  ExifImageWidth?: number; ExifImageHeight?: number;
  latitude?: number; longitude?: number;
};

async function readTags(bytes: Uint8Array): Promise<Tags> {
  try {
    const t: unknown = await exifr.parse(Buffer.from(bytes), {
      tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
      reviveValues: false, translateValues: false, mergeOutput: true,
    });
    return typeof t === 'object' && t !== null ? (t as Tags) : {};
  } catch {
    // A photo whose EXIF does not parse still gets stored and shown; it just has no metadata.
    return {};
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.replace(/\0/g, '').trim() !== '' ? v.replace(/\0/g, '').trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** The zone's offset at that UTC instant, `+09:00`. */
function offsetIn(tz: string, at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

/** `2026:10:12 14:03:22` plus its offset tag, or the memo's zone when the camera wrote none. */
export function takenAtOf(dateTime: string | null, offset: string | null, tz: string): string | null {
  const m = dateTime ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime) : null;
  if (!m || m[1] === '0000') return null;
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) return `${wall}${offset}`;
  // The wall time read as UTC is off by the offset at most, which only matters within hours of a DST switch.
  return `${wall}${offsetIn(tz, new Date(`${wall}Z`))}`;
}

const exposureOf = (t: number | null) => (t === null || t <= 0 ? null : t >= 1 ? `${round(t, 1)}s` : `1/${Math.round(1 / t)}`);

export type PhotoFacts = Pick<Attachment, 'width' | 'height' | 'takenAt' | 'device' | 'camera'> & { readonly gps: { readonly lat: number; readonly lon: number } | null };

export async function photoFacts(bytes: Uint8Array, tz: string): Promise<PhotoFacts> {
  const t = await readTags(bytes);
  const device: PhotoDevice = { make: str(t.Make), model: str(t.Model), lens: str(t.LensModel), software: str(t.Software) };
  const flash = num(t.Flash);
  const camera: PhotoCamera = {
    exposure: exposureOf(num(t.ExposureTime)),
    fNumber: num(t.FNumber) === null ? null : round(t.FNumber!, 1),
    iso: num(t.ISO),
    focal35mm: num(t.FocalLengthIn35mmFormat),
    flash: flash === null ? null : (flash & 1) === 1,
  };
  const w = num(t.ExifImageWidth);
  const h = num(t.ExifImageHeight);
  // Orientations 5–8 are stored sideways: the photo as seen is the other way round.
  const sideways = (num(t.Orientation) ?? 1) >= 5;
  const lat = num(t.latitude);
  const lon = num(t.longitude);
  return {
    width: sideways ? h : w,
    height: sideways ? w : h,
    takenAt: takenAtOf(str(t.DateTimeOriginal), str(t.OffsetTimeOriginal), tz),
    device: Object.values(device).some((v) => v !== null) ? device : null,
    camera: Object.values(camera).some((v) => v !== null) ? camera : null,
    // 0,0 is what some apps write for "no fix".
    gps: lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0) ? { lat: round(lat, 5), lon: round(lon, 5) } : null,
  };
}

/**
 * The photo's own GPS when it had one. A camera photo without GPS was taken just now, so the
 * memo's fix stands in. An old photo from the gallery or a share says nothing about where the
 * memo was written, so it gets none.
 */
export function photoLocation(gps: PhotoFacts['gps'], req: AttachmentRequest, memoFix: GeoPoint | null): PhotoLocation | null {
  if (gps) return { ...gps, place: req.place, address: req.address, from: 'exif' };
  if (req.origin === 'camera' && memoFix) return { ...memoFix, from: 'device' };
  return null;
}

export function describeDevice(d: PhotoDevice | null): string | null {
  if (!d || (!d.make && !d.model)) return null;
  // Apple writes "Apple" / "iPhone 15"; Samsung writes "samsung" / "SM-S928N". Don't repeat a make the model already starts with.
  return d.make && d.model?.toLowerCase().startsWith(d.make.toLowerCase()) ? d.model : [d.make, d.model].filter(Boolean).join(' ');
}

/** One line per photo for the classifier and the ingest prompt: when, where, on what. */
export function describePhoto(a: Attachment, i: number, t: Text): string {
  const when = a.takenAt ? a.takenAt.slice(0, 16).replace('T', ' ') : null;
  const where = a.location ? (a.location.place ?? `${a.location.lat}, ${a.location.lon}`) : null;
  return t.photo(i + 1, [when, where, describeDevice(a.device)].filter((x): x is string => !!x));
}


export function renderAttachment(a: Attachment): Record<string, unknown> {
  const loc = a.location;
  return {
    file: a.file,
    original: a.original,
    sha256: a.sha256,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    origin: a.origin,
    taken_at: a.takenAt,
    location: loc ? { lat: loc.lat, lon: loc.lon, place: loc.place, address: loc.address, from: loc.from } : null,
    device: a.device,
    camera: a.camera && { exposure: a.camera.exposure, f_number: a.camera.fNumber, iso: a.camera.iso, focal_35mm: a.camera.focal35mm, flash: a.camera.flash },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** The frontmatter list back. Only `file`, `original`, `sha256` and `origin` are required; the rest degrades to null. */
export function parseAttachments(v: unknown): Parsed<readonly Attachment[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, detail: 'attachments: expected a list' };
  const out: Attachment[] = [];
  for (const [i, a] of v.entries()) {
    if (!isRecord(a) || typeof a.file !== 'string' || typeof a.original !== 'string' || typeof a.sha256 !== 'string' || !PHOTO_ORIGINS.includes(a.origin as PhotoOrigin)) {
      return { ok: false, detail: `attachments[${i}]: file, original, sha256, origin required` };
    }
    const l = a.location;
    const d = a.device;
    const c = a.camera;
    out.push({
      file: a.file,
      original: a.original,
      sha256: a.sha256,
      bytes: numOrNull(a.bytes) ?? 0,
      width: numOrNull(a.width),
      height: numOrNull(a.height),
      origin: a.origin as PhotoOrigin,
      takenAt: strOrNull(a.taken_at),
      location: isRecord(l) && typeof l.lat === 'number' && typeof l.lon === 'number'
        ? { lat: l.lat, lon: l.lon, place: strOrNull(l.place), address: strOrNull(l.address), from: l.from === 'device' ? 'device' : 'exif' }
        : null,
      device: isRecord(d) ? { make: strOrNull(d.make), model: strOrNull(d.model), lens: strOrNull(d.lens), software: strOrNull(d.software) } : null,
      camera: isRecord(c)
        ? { exposure: strOrNull(c.exposure), fNumber: numOrNull(c.f_number), iso: numOrNull(c.iso), focal35mm: numOrNull(c.focal_35mm), flash: typeof c.flash === 'boolean' ? c.flash : null }
        : null,
    });
  }
  return { ok: true, value: out };
}

/** The request list: n is 1..MAX_PHOTOS and unique. */
export function parseAttachmentRequests(v: unknown): Parsed<readonly AttachmentRequest[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, detail: 'attachments: expected a list' };
  if (v.length > MAX_PHOTOS) return { ok: false, detail: `attachments: at most ${MAX_PHOTOS}` };
  const out: AttachmentRequest[] = [];
  for (const [i, a] of v.entries()) {
    if (!isRecord(a)) return { ok: false, detail: `attachments[${i}]: expected an object` };
    const { n, origin, place, address } = a;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PHOTOS) return { ok: false, detail: `attachments[${i}].n: an integer from 1 to ${MAX_PHOTOS}` };
    if (out.some((x) => x.n === n)) return { ok: false, detail: `attachments[${i}].n: ${n} repeats` };
    if (!PHOTO_ORIGINS.includes(origin as PhotoOrigin)) return { ok: false, detail: `attachments[${i}].origin: one of ${PHOTO_ORIGINS.join(', ')}` };
    if (place !== undefined && place !== null && typeof place !== 'string') return { ok: false, detail: `attachments[${i}].place: expected a string` };
    if (address !== undefined && address !== null && typeof address !== 'string') return { ok: false, detail: `attachments[${i}].address: expected a string` };
    out.push({ n, origin: origin as PhotoOrigin, place: typeof place === 'string' ? place : null, address: typeof address === 'string' ? address : null });
  }
  return { ok: true, value: out };
}


const embed = (file: string) => `![[${file}]]`;

/** The memo body: the text, then one embed per photo, the way Obsidian lays out a pasted image. */
export function withEmbeds(text: string, attachments: readonly Attachment[]): string {
  if (!attachments.length) return text;
  const embeds = attachments.map((a) => embed(a.file)).join('\n');
  return text === '' ? embeds : `${text}\n\n${embeds}`;
}

/** Undoes withEmbeds: only a trailing run of exactly those embed lines is taken off. */
export function withoutEmbeds(body: string, attachments: readonly Attachment[]): string {
  if (!attachments.length) return body;
  const embeds = attachments.map((a) => embed(a.file)).join('\n');
  if (body === embeds) return '';
  return body.endsWith(`\n\n${embeds}`) ? body.slice(0, -(embeds.length + 2)) : body;
}

/**
 * Builds JPEGs with chosen EXIF tags, so photo tests read known values without binary fixtures
 * beyond one plain image. Big-endian TIFF, the layout phone cameras write.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAIN_JPEG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'photos', 'plain.jpg'));

type Value = { type: 'ascii'; v: string } | { type: 'short'; v: number[] } | { type: 'long'; v: number[] } | { type: 'rational'; v: [number, number][] };
type Entry = { tag: number; value: Value };

const ascii = (v: string): Value => ({ type: 'ascii', v });
const short = (...v: number[]): Value => ({ type: 'short', v });
const rational = (...v: [number, number][]): Value => ({ type: 'rational', v });
const TYPE = { ascii: 2, short: 3, long: 4, rational: 5 } as const;

function bytesOf(value: Value): Buffer {
  switch (value.type) {
    case 'ascii': return Buffer.from(`${value.v}\0`, 'latin1');
    case 'short': return Buffer.concat(value.v.map((n) => Buffer.from([n >> 8, n & 0xff])));
    case 'long': return Buffer.concat(value.v.map((n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }));
    case 'rational': return Buffer.concat(value.v.map(([a, b]) => { const x = Buffer.alloc(8); x.writeUInt32BE(a); x.writeUInt32BE(b, 4); return x; }));
  }
}

const countOf = (value: Value) => (value.type === 'ascii' ? value.v.length + 1 : value.v.length);

/** One IFD at `offset` (from the TIFF start), with its out-of-line values right after it. */
function ifd(entries: readonly Entry[], offset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + sorted.length * 12 + 4);
  head.writeUInt16BE(sorted.length);
  let dataAt = offset + head.length;
  const data: Buffer[] = [];
  sorted.forEach((e, i) => {
    const at = 2 + i * 12;
    const b = bytesOf(e.value);
    head.writeUInt16BE(e.tag, at);
    head.writeUInt16BE(TYPE[e.value.type], at + 2);
    head.writeUInt32BE(countOf(e.value), at + 4);
    if (b.length <= 4) b.copy(head, at + 8);
    else {
      head.writeUInt32BE(dataAt, at + 8);
      const padded = b.length % 2 ? Buffer.concat([b, Buffer.alloc(1)]) : b;
      data.push(padded);
      dataAt += padded.length;
    }
  });
  return Buffer.concat([head, ...data]);
}

export type ExifSpec = {
  make?: string;
  model?: string;
  software?: string;
  orientation?: number;
  /** `YYYY:MM:DD HH:MM:SS`, as cameras write it. */
  taken?: string;
  offset?: string;
  lens?: string;
  exposure?: [number, number];
  fNumber?: [number, number];
  iso?: number;
  focal35?: number;
  flash?: number;
  /** Decimal degrees; south and west are negative. */
  gps?: { lat: number; lon: number };
};

const dms = (deg: number): [number, number][] => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 10_000);
  return [[d, 1], [m, 1], [s, 10_000]];
};

export function jpegWithExif(spec: ExifSpec, base: Buffer = PLAIN_JPEG): Buffer {
  const exif: Entry[] = [
    ...(spec.exposure ? [{ tag: 0x829a, value: rational(spec.exposure) }] : []),
    ...(spec.fNumber ? [{ tag: 0x829d, value: rational(spec.fNumber) }] : []),
    ...(spec.iso !== undefined ? [{ tag: 0x8827, value: short(spec.iso) }] : []),
    ...(spec.taken ? [{ tag: 0x9003, value: ascii(spec.taken) }] : []),
    ...(spec.offset ? [{ tag: 0x9011, value: ascii(spec.offset) }] : []),
    ...(spec.flash !== undefined ? [{ tag: 0x9209, value: short(spec.flash) }] : []),
    ...(spec.focal35 !== undefined ? [{ tag: 0xa405, value: short(spec.focal35) }] : []),
    ...(spec.lens ? [{ tag: 0xa434, value: ascii(spec.lens) }] : []),
  ];
  const gps: Entry[] = spec.gps
    ? [
        { tag: 1, value: ascii(spec.gps.lat < 0 ? 'S' : 'N') },
        { tag: 2, value: rational(...dms(spec.gps.lat)) },
        { tag: 3, value: ascii(spec.gps.lon < 0 ? 'W' : 'E') },
        { tag: 4, value: rational(...dms(spec.gps.lon)) },
      ]
    : [];
  const ifd0Base: Entry[] = [
    ...(spec.make ? [{ tag: 0x010f, value: ascii(spec.make) }] : []),
    ...(spec.model ? [{ tag: 0x0110, value: ascii(spec.model) }] : []),
    ...(spec.orientation ? [{ tag: 0x0112, value: short(spec.orientation) }] : []),
    ...(spec.software ? [{ tag: 0x0131, value: ascii(spec.software) }] : []),
  ];
  // Pointer entries need the sub-IFD offsets, which depend on IFD0's size; the size does not depend on the pointer values.
  const pointers = (exifAt: number, gpsAt: number): Entry[] => [
    ...(exif.length ? [{ tag: 0x8769, value: { type: 'long', v: [exifAt] } as Value }] : []),
    ...(gps.length ? [{ tag: 0x8825, value: { type: 'long', v: [gpsAt] } as Value }] : []),
  ];
  const ifd0Size = ifd([...ifd0Base, ...pointers(0, 0)], 8).length;
  const exifAt = 8 + ifd0Size;
  const exifBuf = exif.length ? ifd(exif, exifAt) : Buffer.alloc(0);
  const gpsAt = exifAt + exifBuf.length;
  const gpsBuf = gps.length ? ifd(gps, gpsAt) : Buffer.alloc(0);
  const tiff = Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]), ifd([...ifd0Base, ...pointers(exifAt, gpsAt)], 8), exifBuf, gpsBuf]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  // Right after SOI, ahead of any JFIF APP0, the way cameras order it.
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

/** A Galaxy shot in 사직동 with every field the gateway reads. */
export const GALAXY: ExifSpec = {
  make: 'samsung', model: 'SM-S928N', software: 'S928NXXU1AXA1', orientation: 6,
  taken: '2026:10:12 14:03:22', offset: '+09:00', lens: 'Galaxy S24 Ultra Rear Wide Camera',
  exposure: [1, 120], fNumber: [17, 10], iso: 50, focal35: 23, flash: 16,
  gps: { lat: 37.57591, lon: 126.96877 },
};

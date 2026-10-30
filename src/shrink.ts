/**
 * The ShrinkPhoto port on macOS: sips ships with the OS the gateway runs on, and reads HEIC,
 * which the phone may send and neither Obsidian nor the model can show.
 */

import type { Run } from './enrich.ts';
import type { ShrinkPhoto } from './wiki/index.ts';

const SHRINK_TIMEOUT_MS = 60_000;
const LONG_EDGE = 2048;

/** The long edge in pixels, from `sips -g`, or null when sips cannot read the file. */
export function longEdgeOf(sipsOutput: string): number | null {
  const w = /pixelWidth: (\d+)/.exec(sipsOutput)?.[1];
  const h = /pixelHeight: (\d+)/.exec(sipsOutput)?.[1];
  return w && h ? Math.max(Number(w), Number(h)) : null;
}

/** The EXIF block, orientation included, is carried over. */
export function sipsShrink(run: Run, bin = '/usr/bin/sips'): ShrinkPhoto {
  return async (src, dst) => {
    const size = await run(bin, ['-g', 'pixelWidth', '-g', 'pixelHeight', src], SHRINK_TIMEOUT_MS);
    const edge = size.code === 0 ? longEdgeOf(size.stdout) : null;
    if (edge === null) throw new Error(`sips cannot read ${src}: ${size.stderr.trim().split('\n').pop() ?? ''}`);
    // -Z enlarges a smaller image to the cap, whatever the man page says, so it is passed only to shrink.
    const resize = edge > LONG_EDGE ? ['-Z', String(LONG_EDGE)] : [];
    const r = await run(bin, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', ...resize, src, '--out', dst], SHRINK_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`sips exited ${r.code ?? 'by signal'}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
  };
}

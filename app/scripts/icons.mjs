#!/usr/bin/env node
// Renders the adaptive launcher icon and splash PNGs in assets/images from the acorn in src/ui/acorn.ts.
// Rerun after changing the acorn: npm run icons
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACORN, ACORN_LINE_COLOR, ACORN_STROKE_WIDTH, ACORN_TILE_COLOR, ACORN_TILE_RADIUS, ACORN_VIEWBOX } from '../src/ui/acorn.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'images');
const PX = 1024;
// The splash artboard draws a 104px acorn on a 160px tile. Every large rendering keeps that ratio.
const GLYPH_IN_TILE = 104 / 160;
// Adaptive icon geometry in dp: a 108 canvas, a 72 viewport the launcher shows, a 66 safe circle.
const ADAPTIVE = { canvas: 108, viewport: 72, safe: 66 };

const glyph = (size, center) => {
  const paths = ACORN.map((s) => `<path d="${s.d}"${s.width ? ` stroke-width="${s.width}"` : ''}/>`).join('');
  const at = center - size / 2;
  return `<g transform="translate(${at} ${at}) scale(${size / ACORN_VIEWBOX})" fill="none" stroke="${ACORN_LINE_COLOR}" stroke-width="${ACORN_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="0 0 ${PX} ${PX}">${body}</svg>`;

const render = (body) => new Resvg(svg(body), { fitTo: { mode: 'original' } }).render();

function assertInsideSafeZone(image) {
  const r = (ADAPTIVE.safe / 2 / ADAPTIVE.canvas) * PX;
  const c = PX / 2;
  const { pixels, width, height } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 0 && Math.hypot(x + 0.5 - c, y + 0.5 - c) > r) {
        throw new Error(`adaptive icon foreground leaves the ${ADAPTIVE.safe}dp safe zone at (${x}, ${y})`);
      }
    }
  }
}

const adaptiveGlyph = (ADAPTIVE.viewport / ADAPTIVE.canvas) * PX * GLYPH_IN_TILE;
const foreground = render(glyph(adaptiveGlyph, PX / 2));
assertInsideSafeZone(foreground);

const files = {
  'android-icon-foreground.png': foreground,
  'splash-icon.png': render(`<rect width="${PX}" height="${PX}" rx="${PX * ACORN_TILE_RADIUS}" fill="${ACORN_TILE_COLOR}"/>${glyph(PX * GLYPH_IN_TILE, PX / 2)}`),
};

for (const [name, image] of Object.entries(files)) {
  writeFileSync(join(OUT, name), image.asPng());
  console.log(join('assets', 'images', name));
}

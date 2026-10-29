import { WIDTH, HEIGHT } from './config.js';
import { LED_MAP, DOT_RATIO } from './mask-shape.js';
import { gammaLut } from './layout.js';

// Renders an image the way the mask shows it: round LED dots on a black face
// plate with the real oval outline and eye holes, instead of a smooth bitmap.
export const CELL = 12;           // preview pixels per LED cell (the LEDs are square-pitched)
export const PAD = 1.5 * CELL;    // margin around the grid for the bezel
export const PREVIEW_W = WIDTH * CELL + 2 * PAD;
export const PREVIEW_H = HEIGHT * CELL + 2 * PAD;

const PLATE = [11, 11, 14];
const EDGE = [52, 52, 62];
const BEZEL_REACH = 1.15; // how far the plate extends past the outermost LEDs, in cells
const LED_GAMMA = 2.2;    // LEDs emit light linearly in the data value; screens are ~2.2 gamma

const led = LED_MAP.map((row) => [...row].map((c) => c === '#'));
const spans = led.map((row) => {
  const first = row.indexOf(true);
  return first < 0 ? null : [first, row.lastIndexOf(true)];
});

function isPlate(px, py) {
  const u = (px + 0.5 - PAD) / CELL;
  const v = (py + 0.5 - PAD) / CELL;
  const j = Math.floor(v);
  const i = Math.floor(u);
  const span = spans[j];
  // Between a row's first and last LED the plate is exactly the LED cells, so the
  // eye holes (gaps in the map) stay open.
  if (span && u >= span[0] && u <= span[1] + 1) return led[j][i];
  let d = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (led[j + dj]?.[i + di]) d = Math.min(d, Math.hypot(u - (i + di + 0.5), v - (j + dj + 0.5)));
    }
  }
  return d <= BEZEL_REACH;
}

let plateCache;
function plateLayer() {
  if (plateCache) return plateCache;
  const mask = new Uint8Array(PREVIEW_W * PREVIEW_H);
  for (let py = 0; py < PREVIEW_H; py++) {
    for (let px = 0; px < PREVIEW_W; px++) mask[py * PREVIEW_W + px] = isPlate(px, py) ? 1 : 0;
  }
  const at = (x, y) => (x >= 0 && y >= 0 && x < PREVIEW_W && y < PREVIEW_H ? mask[y * PREVIEW_W + x] : 0);
  const data = new Uint8ClampedArray(PREVIEW_W * PREVIEW_H * 4); // transparent outside the mask
  for (let py = 0; py < PREVIEW_H; py++) {
    for (let px = 0; px < PREVIEW_W; px++) {
      if (!mask[py * PREVIEW_W + px]) continue;
      const edge = !at(px - 2, py) || !at(px + 2, py) || !at(px, py - 2) || !at(px, py + 2);
      data.set([...(edge ? EDGE : PLATE), 255], (py * PREVIEW_W + px) * 4);
    }
  }
  plateCache = data;
  return data;
}

// Coverage of one LED dot at each pixel of its cell: a soft-edged disc plus a faint glow.
const kernel = (() => {
  const k = new Float32Array(CELL * CELL);
  const rc = DOT_RATIO / 2;
  for (let py = 0; py < CELL; py++) {
    for (let px = 0; px < CELL; px++) {
      const d = Math.hypot((px + 0.5) / CELL - 0.5, (py + 0.5) / CELL - 0.5);
      const t = Math.min(1, Math.max(0, (d - 0.8 * rc) / (0.4 * rc)));
      const core = 1 - t * t * (3 - 2 * t);
      k[py * CELL + px] = Math.min(1, core + 0.12 * Math.exp(-((d / 0.32) ** 2)));
    }
  }
  return k;
})();

// img: 46x58 ImageData of what you want to see. gamma: the contrast setting that
// is applied to the data sent to the mask, so the preview shows the same result.
export function renderMaskPreview(img, { gamma = 1 } = {}) {
  const out = new ImageData(PREVIEW_W, PREVIEW_H);
  out.data.set(plateLayer());

  const lut = gammaLut(gamma);
  const disp = new Uint8ClampedArray(256); // data value -> colour on screen
  for (let v = 0; v < 256; v++) disp[v] = Math.round(255 * (lut[v] / 255) ** (1 / LED_GAMMA));

  for (let j = 0; j < HEIGHT; j++) {
    for (let i = 0; i < WIDTH; i++) {
      if (!led[j][i]) continue;
      const s = (j * WIDTH + i) * 4;
      const r = disp[img.data[s]];
      const g = disp[img.data[s + 1]];
      const b = disp[img.data[s + 2]];
      for (let py = 0; py < CELL; py++) {
        let o = ((PAD + j * CELL + py) * PREVIEW_W + PAD + i * CELL) * 4;
        for (let px = 0; px < CELL; px++, o += 4) {
          const k = kernel[py * CELL + px];
          out.data[o] = out.data[o] * (1 - k) + r * k;
          out.data[o + 1] = out.data[o + 1] * (1 - k) + g * k;
          out.data[o + 2] = out.data[o + 2] * (1 - k) + b * k;
        }
      }
    }
  }
  return out;
}

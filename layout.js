import { WIDTH, HEIGHT, EYE_LINE_Y, ORDER, FLIP_X, FLIP_Y } from './config.js';

const canvas = document.createElement('canvas');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.imageSmoothingQuality = 'high';

// How pixels are serialised for the mask. Adjustable in the UI to compensate
// for mirrored / upside-down / wrong-colour output.
export const DEFAULT_LAYOUT = { order: ORDER, flipX: FLIP_X, flipY: FLIP_Y, colors: 'RGB', gamma: 1 };

// LEDs emit light linearly in the data value, but pictures are gamma-encoded, so
// mid-tones come out too bright and contrast flattens. gamma > 1 compensates.
export function gammaLut(gamma = 1) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * (v / 255) ** gamma);
  return lut;
}

// mode 'full'  : cover the whole grid (crops overflow; eye-hole pixels are lost)
// mode 'below' : contain inside the area under the eye line
export function renderFrame(src, mode, eyeLine = EYE_LINE_Y) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const top = mode === 'below' ? eyeLine : 0;
  const boxW = WIDTH;
  const boxH = HEIGHT - top;
  const scale = (mode === 'below' ? Math.min : Math.max)(boxW / src.width, boxH / src.height);
  const w = src.width * scale;
  const h = src.height * scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, boxW, boxH);
  ctx.clip();
  ctx.drawImage(src, (boxW - w) / 2, top + (boxH - h) / 2, w, h);
  ctx.restore();

  return ctx.getImageData(0, 0, WIDTH, HEIGHT);
}

// ImageData -> RGB bytes in the mask's pixel order. cfg.colors names the order
// the mask receives its channels in (e.g. 'BGR' sends blue first).
export function toMaskBytes(img, cfg = DEFAULT_LAYOUT) {
  const channels = [...cfg.colors].map((c) => 'RGB'.indexOf(c));
  const lut = gammaLut(cfg.gamma ?? 1);
  const out = new Uint8Array(WIDTH * HEIGHT * 3);
  let o = 0;
  const px = (x, y) => {
    const sx = cfg.flipX ? WIDTH - 1 - x : x;
    const sy = cfg.flipY ? HEIGHT - 1 - y : y;
    const i = (sy * WIDTH + sx) * 4;
    for (const c of channels) out[o++] = lut[img.data[i + c]];
  };
  if (cfg.order === 'cols') {
    for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) px(x, y);
  } else {
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) px(x, y);
  }
  return out;
}

export const PATTERNS = {
  orient: 'Orientation (big F)',
  cols: 'Column colour bars',
  rows: 'Row colour bars',
  rings: 'Rings (what is visible)',
  eye: 'Eye line',
};

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const CYAN = [0, 255, 255];
const RING_COLORS = [RED, GREEN, BLUE, [255, 255, 0], CYAN, [255, 0, 255], WHITE];

// Calibration images as plain ImageData. Features stay inside the visible oval,
// and are big enough to survive a saturated, moire-prone phone photo.
export function calibrationPattern(name, eyeLine = EYE_LINE_Y) {
  const img = new ImageData(WIDTH, HEIGHT);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  const rect = (x0, y0, w, h, [r, g, b]) => {
    for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(WIDTH, x0 + w); x++) {
        img.data.set([r, g, b], (y * WIDTH + x) * 4);
      }
    }
  };

  if (name === 'orient') {
    rect(14, 8, 6, 42, WHITE);  // F stem
    rect(14, 8, 23, 6, WHITE);  // F top bar
    rect(14, 26, 17, 6, WHITE); // F middle bar
    rect(8, 8, 2, 42, RED);     // red vertical line, left of the F
    rect(12, 4, 22, 2, BLUE);   // blue horizontal line, above the F
  } else if (name === 'cols') {
    rect(0, 0, 15, HEIGHT, RED);
    rect(15, 0, 16, HEIGHT, GREEN);
    rect(31, 0, WIDTH - 31, HEIGHT, BLUE);
  } else if (name === 'rows') {
    rect(0, 0, WIDTH, 19, RED);
    rect(0, 19, WIDTH, 20, GREEN);
    rect(0, 39, WIDTH, HEIGHT - 39, BLUE);
  } else if (name === 'rings') {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const d = Math.min(x, y, WIDTH - 1 - x, HEIGHT - 1 - y);
        img.data.set(RING_COLORS[Math.floor(d / 3) % RING_COLORS.length], (y * WIDTH + x) * 4);
      }
    }
  } else if (name === 'eye') {
    // Ruler near the centre column (every 5 rows, long every 10) and the eye line.
    for (let y = 5; y < HEIGHT - 4; y += 5) {
      if (y % 10) rect(21, y, 3, 1, WHITE);
      else rect(19, y, 7, 1, WHITE);
    }
    rect(0, eyeLine, WIDTH, 1, CYAN);
  } else {
    throw new Error(`Unknown pattern ${name}`);
  }
  return img;
}

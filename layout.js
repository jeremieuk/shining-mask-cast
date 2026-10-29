import { WIDTH, HEIGHT, EYE_LINE_Y, ORDER, FLIP_X, FLIP_Y } from './config.js';

const canvas = document.createElement('canvas');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.imageSmoothingQuality = 'high';

// mode 'full'  : cover the whole grid (crops overflow; eye-hole pixels are lost)
// mode 'below' : contain inside the area under the eye line
export function renderFrame(src, mode) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const top = mode === 'below' ? EYE_LINE_Y : 0;
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

// ImageData -> RGB bytes in the mask's pixel order.
export function toMaskBytes(img) {
  const out = new Uint8Array(WIDTH * HEIGHT * 3);
  let o = 0;
  const px = (x, y) => {
    const sx = FLIP_X ? WIDTH - 1 - x : x;
    const sy = FLIP_Y ? HEIGHT - 1 - y : y;
    const i = (sy * WIDTH + sx) * 4;
    out[o++] = img.data[i];
    out[o++] = img.data[i + 1];
    out[o++] = img.data[i + 2];
  };
  if (ORDER === 'cols') {
    for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) px(x, y);
  } else {
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) px(x, y);
  }
  return out;
}

// Gradient with coloured corners (TL red, TR green, BL blue, BR white) and
// row ticks on the left edge (long every 10 rows) to read off orientation,
// size and the eye line.
export function testPattern() {
  const img = new ImageData(WIDTH, HEIGHT);
  const set = (x, y, r, g, b) => {
    const i = (y * WIDTH + x) * 4;
    img.data.set([r, g, b, 255], i);
  };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const v = Math.round((x / (WIDTH - 1)) * 120);
      set(x, y, v, v, v);
    }
  }
  const block = (x0, y0, r, g, b) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x0 + x, y0 + y, r, g, b);
  };
  block(0, 0, 255, 0, 0);
  block(WIDTH - 4, 0, 0, 255, 0);
  block(0, HEIGHT - 4, 0, 0, 255);
  block(WIDTH - 4, HEIGHT - 4, 255, 255, 255);
  for (let y = 5; y < HEIGHT - 5; y++) {
    if (y % 5) continue;
    const len = y % 10 ? 3 : 7;
    for (let x = 0; x < len; x++) set(x, y, 255, 255, 0);
  }
  return img;
}

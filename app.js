import { WIDTH, HEIGHT, EYE_LINE_Y, SLOT_START } from './config.js';
import { extractFrames } from './frames.js';
import { renderFrame, toMaskBytes, testPattern } from './layout.js';
import { MaskClient } from './mask.js';

const $ = (id) => document.getElementById(id);
const SCALE = 8;

function log(msg) {
  const el = $('log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const mask = new MaskClient(log);
let file = null;
let sources = [];
let rendered = [];
let animTimer = null;
let frameIdx = 0;

const mode = () => document.querySelector('input[name=mode]:checked').value;

const small = document.createElement('canvas');
small.width = WIDTH;
small.height = HEIGHT;
const smallCtx = small.getContext('2d');
const pctx = $('preview').getContext('2d');
pctx.imageSmoothingEnabled = false;

function drawPreview() {
  if (!rendered.length) return;
  smallCtx.putImageData(rendered[frameIdx % rendered.length], 0, 0);
  pctx.drawImage(small, 0, 0, WIDTH * SCALE, HEIGHT * SCALE);
  pctx.strokeStyle = 'rgba(255,255,255,.5)';
  pctx.setLineDash([6, 6]);
  pctx.beginPath();
  pctx.moveTo(0, EYE_LINE_Y * SCALE);
  pctx.lineTo(WIDTH * SCALE, EYE_LINE_Y * SCALE);
  pctx.stroke();
  frameIdx++;
}

function relayout() {
  rendered = sources.map((s) => renderFrame(s, mode()));
  frameIdx = 0;
  clearInterval(animTimer);
  drawPreview();
  if (rendered.length > 1) animTimer = setInterval(drawPreview, 250);
}

async function loadFile(f) {
  file = f;
  $('name').textContent = f.name || f.type;
  $('send').disabled = true;
  try {
    sources = await extractFrames(f, +$('frames').value);
    log(`Loaded ${sources.length} frame(s)`);
    relayout();
    $('send').disabled = false;
  } catch (e) {
    log(`Error: ${e.message}`);
  }
}

async function sendImages(imgs) {
  const prog = $('prog');
  prog.hidden = false;
  prog.value = 0;
  $('send').disabled = $('test').disabled = true;
  try {
    await mask.connect();
    await mask.setLight(+$('bright').value);
    const slots = imgs.map((_, i) => SLOT_START + i);
    for (let i = 0; i < imgs.length; i++) {
      log(`Uploading frame ${i + 1}/${imgs.length}`);
      await mask.uploadImage(slots[i], toMaskBytes(imgs[i]), (p) => {
        prog.value = (i + p) / imgs.length;
      });
    }
    await mask.play(slots);
    log('Playing on mask');
  } catch (e) {
    log(`Error: ${e.message}`);
  } finally {
    if (!$('stay').checked) mask.disconnect();
    prog.hidden = true;
    $('test').disabled = false;
    $('send').disabled = !file;
  }
}

$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
document.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = relayout));
$('frames').oninput = () => {
  $('nVal').textContent = $('frames').value;
};
$('frames').onchange = () => file && loadFile(file);
$('bright').oninput = () => {
  $('bVal').textContent = $('bright').value;
};
$('send').onclick = () => sendImages(rendered);
$('test').onclick = () => sendImages([testPattern()]);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`SW: ${e.message}`));
}

// Opened via Android's Share menu: the service worker stashed the file.
if (new URLSearchParams(location.search).has('shared')) {
  (async () => {
    try {
      const cache = await caches.open('mask-cast-share');
      const res = await cache.match(new URL('shared-file', location.href));
      if (res) {
        const blob = await res.blob();
        await loadFile(new File([blob], 'shared', { type: blob.type }));
        log('Shared file ready. Tap Send.');
      }
    } catch (e) {
      log(`Share error: ${e.message}`);
    }
    history.replaceState(null, '', location.pathname);
  })();
}

import { WIDTH, HEIGHT, EYE_LINE_Y, SLOT_START } from './config.js';
import { extractFrames } from './frames.js';
import { renderFrame, toMaskBytes, testPattern } from './layout.js';
import { MaskClient } from './mask.js';

const $ = (id) => document.getElementById(id);
const SCALE = 8;
const MAX_TRACE = 500;

// Diagnostics log: every line is timestamped and can be copied out.
const traceLines = [];
function trace(dir, text) {
  const t = new Date();
  const ts = `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  traceLines.push(`${ts} ${dir} ${text}`);
  if (traceLines.length > MAX_TRACE) traceLines.shift();
  const el = $('diag');
  el.textContent = traceLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// User-facing messages (also recorded in the diagnostics log).
function log(msg) {
  const el = $('log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
  trace('i', msg.replace(/\n\s*/g, ' '));
}

const HINTS = {
  NotFoundError: 'No device was chosen or none was found. Make sure the mask is on and close the Shining app, then try again.',
  SecurityError: 'Bluetooth was blocked. It needs HTTPS and a tap on the button.',
  NetworkError: 'Could not connect: the mask is out of range, or another phone/app is already connected to it.',
  NotSupportedError: 'This browser or phone does not support that Bluetooth operation.',
  InvalidStateError: 'Bluetooth is in an unexpected state. Toggle Bluetooth off and on.',
  NotMaskError: 'The device you picked is not a Shining mask. Nothing was sent to it.',
};

function explain(e) {
  const hint = HINTS[e.name];
  return `${e.name}: ${e.message}${hint ? `\nHint: ${hint}` : ''}`;
}

let busy = false;
const mask = new MaskClient({ trace, onState: updateUi });
let file = null;
let sources = [];
let rendered = [];
let animTimer = null;
let frameIdx = 0;

const mode = () => document.querySelector('input[name=mode]:checked').value;

function updateUi() {
  const name = mask.device?.name ?? 'unnamed';
  $('status').textContent = mask.ready
    ? `✅ Mask verified: ${name}`
    : mask.known
      ? `Mask ${name} verified earlier (disconnected, reconnects on send)`
      : 'Not connected';
  $('send').disabled = busy || !mask.known || !sources.length;
  $('test').disabled = busy || !mask.known;
  $('connect').disabled = $('scanAll').disabled = busy;
}

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
  sources = [];
  $('name').textContent = f.name || f.type;
  updateUi();
  try {
    sources = await extractFrames(f, +$('frames').value);
    log(`Loaded ${sources.length} frame(s)`);
    relayout();
  } catch (e) {
    log(`Error: ${e.message}`);
  }
  updateUi();
}

async function connect(opts) {
  busy = true;
  updateUi();
  try {
    await mask.connect(opts);
    log('Mask connected and verified');
  } catch (e) {
    log(explain(e));
  } finally {
    busy = false;
    updateUi();
  }
}

async function sendImages(imgs) {
  const prog = $('prog');
  prog.hidden = false;
  prog.value = 0;
  busy = true;
  updateUi();
  try {
    await mask.ensureConnected(); // only ever reconnects the already-verified mask
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
    log(explain(e));
  } finally {
    if (!$('stay').checked) mask.disconnect();
    prog.hidden = true;
    busy = false;
    updateUi();
  }
}

$('connect').onclick = () => connect();
$('scanAll').onclick = () => connect({ acceptAll: true });
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
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(traceLines.join('\n'));
    log('Diagnostics log copied');
  } catch {
    log('Could not copy automatically; select the text in Diagnostics instead');
  }
};

(async function logEnvironment() {
  trace('env', `secureContext=${isSecureContext} webBluetooth=${!!navigator.bluetooth}`);
  try {
    trace('env', `bluetooth available=${await navigator.bluetooth.getAvailability()}`);
  } catch { /* not supported */ }
  trace('env', navigator.userAgent);
})();

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
        log('Shared file ready. Connect to your mask, then tap Send.');
      }
    } catch (e) {
      log(`Share error: ${e.message}`);
    }
    history.replaceState(null, '', location.pathname);
  })();
}

updateUi();

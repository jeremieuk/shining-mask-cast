import { WIDTH, HEIGHT, SLOT_START, APP_VERSION, EYE_LINE_Y } from './config.js';
import { extractFrames } from './frames.js';
import { renderFrame, toMaskBytes, calibrationPattern, DEFAULT_LAYOUT } from './layout.js';
import { renderMaskPreview, PREVIEW_W, PREVIEW_H, CELL, PAD } from './preview.js';
import { MaskClient } from './mask.js';
import { extractUrl, normalizeUrl } from './link.js';
import { fetchBlob, LoadError, mb } from './net.js';

const $ = (id) => document.getElementById(id);
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

// A slim message floating at the top of the screen showing the latest message, so
// nothing happens silently off-screen. It doesn't move the page, errors stay a
// little longer, and a tap dismisses it.
let noteTimer;
function setNote(msg, kind) {
  const el = $('note');
  el.textContent = msg;
  el.className = `note ${kind}`;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 20000 : 8000);
}
$('note').onclick = () => { $('note').hidden = true; };

// User-facing messages (also recorded in the log below and the diagnostics log).
function log(msg, kind = 'info') {
  const el = $('log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
  trace('i', msg.replace(/\n\s*/g, ' '));
  setNote(msg, kind);
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
let showing = 'file'; // what the preview currently shows: 'file' or 'pattern'

const mode = () => document.querySelector('input[name=mode]:checked').value;
const eyeLine = () => +$('eye').value;

// Per-viewer convenience only; the app works without storage.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// Pixel order / flips / colour order used when sending (saved on this device).
const layoutCfg = { ...DEFAULT_LAYOUT, gamma: 1.8 };
try {
  Object.assign(layoutCfg, JSON.parse(store.get('layout') ?? '{}'));
} catch { /* ignore a corrupt saved value */ }

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
const preview = $('preview');
preview.width = PREVIEW_W;
preview.height = PREVIEW_H;
const pctx = preview.getContext('2d');
pctx.imageSmoothingEnabled = false;

const previewStyle = () => $('style').value;

function blankImage() {
  const img = new ImageData(WIDTH, HEIGHT);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return img;
}

function drawPreview() {
  if (!rendered.length) return;
  const img = rendered[frameIdx % rendered.length];
  pctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  if (previewStyle() === 'mask') {
    pctx.putImageData(renderMaskPreview(img, { gamma: layoutCfg.gamma }), 0, 0);
  } else {
    smallCtx.putImageData(img, 0, 0);
    pctx.fillStyle = '#000';
    pctx.fillRect(PAD, PAD, WIDTH * CELL, HEIGHT * CELL);
    pctx.drawImage(small, PAD, PAD, WIDTH * CELL, HEIGHT * CELL);
  }
  // Top edge of "Below the eyes" mode.
  const y = PAD + eyeLine() * CELL;
  pctx.strokeStyle = 'rgba(255,255,255,.55)';
  pctx.setLineDash([8, 6]);
  pctx.beginPath();
  pctx.moveTo(PAD, y);
  pctx.lineTo(PAD + WIDTH * CELL, y);
  pctx.stroke();
  frameIdx++;
}

// Re-draw the current frame after a setting changes.
function redraw() {
  frameIdx = Math.max(0, frameIdx - 1);
  drawPreview();
}

function relayout() {
  showing = 'file';
  rendered = sources.length ? sources.map((s) => renderFrame(s, mode(), eyeLine())) : [blankImage()];
  frameIdx = 0;
  clearInterval(animTimer);
  drawPreview();
  if (rendered.length > 1) animTimer = setInterval(drawPreview, 250);
}

const currentPattern = () => calibrationPattern($('pattern').value, eyeLine());

// Shows the chosen calibration pattern as it should look on the mask.
function showPattern() {
  showing = 'pattern';
  clearInterval(animTimer);
  rendered = [currentPattern()];
  frameIdx = 0;
  drawPreview();
}

// Loading: one load at a time. Starting a new one cancels the one in flight, and
// every step has a deadline, so Load can't hang silently.
let loadCtl = null; // AbortController of the load in flight

const CORS_MSG = "Couldn't read that link. The site probably blocks other apps from reading it (or you are offline). Try a Giphy or Imgur link, or download it and choose the file.";

function loadStatus(text, kind = '') {
  const el = $('loadStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

function beginLoad() {
  loadCtl?.abort();
  loadCtl = new AbortController();
  $('loadUrl').textContent = 'Cancel';
  return loadCtl;
}

function endLoad(ctl) {
  if (loadCtl !== ctl) return;
  loadCtl = null;
  $('loadUrl').textContent = 'Load';
}

function reportLoadError(e, ctl) {
  if (e.cancelled) {
    if (loadCtl === ctl) loadStatus('Cancelled'); // user cancelled; a newer load stays silent
    return;
  }
  const msg = e instanceof TypeError ? CORS_MSG : e.message;
  loadStatus(msg, 'error');
  log(msg, 'error');
}

const framesLabel = (n) => `Loaded ${n} frame${n === 1 ? '' : 's'}`;

// Decodes a picture or video into frames and shows it. Previous frames stay on
// screen (and Send stays usable) until the new ones are ready.
async function decode(f, ctl) {
  loadStatus('Decoding…');
  const frames = await extractFrames(f, +$('frames').value, {
    signal: ctl.signal,
    onProgress: (i, n) => loadStatus(`Decoding frame ${i} of ${n}…`),
  });
  if (loadCtl !== ctl) {
    frames.forEach((b) => b.close());
    throw new LoadError('Cancelled', true);
  }
  sources.forEach((b) => b.close());
  sources = frames;
  file = f;
  $('name').textContent = f.name || f.type;
  relayout();
  return frames.length;
}

async function loadFile(f) {
  const ctl = beginLoad();
  try {
    const n = await decode(f, ctl);
    loadStatus(framesLabel(n), 'ok');
    log(framesLabel(n));
  } catch (e) {
    reportLoadError(e, ctl);
  } finally {
    endLoad(ctl);
    updateUi();
  }
}

async function connect(opts) {
  busy = true;
  updateUi();
  let hintTimer;
  if (!mask.known || opts?.acceptAll) {
    log('Opening Bluetooth chooser...');
    hintTimer = setTimeout(
      () => log('Still no chooser. Use Chrome (not Samsung Internet), turn on Bluetooth and Location, and allow Chrome the Location / Nearby devices permission.'),
      8000,
    );
  }
  try {
    await mask.connect(opts);
    log('Mask connected and verified');
  } catch (e) {
    log(explain(e), 'error');
  } finally {
    clearTimeout(hintTimer);
    busy = false;
    updateUi();
  }
}

async function loadUrl(raw) {
  const url = normalizeUrl(raw);
  if (!url) {
    loadStatus('Paste a link first', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    loadStatus('Enter a full link starting with http:// or https://', 'error');
    return;
  }
  const ctl = beginLoad();
  log(`Fetching ${url}`);
  try {
    loadStatus('Connecting…');
    const blob = await fetchBlob(url, {
      signal: ctl.signal,
      onProgress: (got, total) => loadStatus(total ? `Downloading ${mb(got)} of ${mb(total)} MB…` : `Downloading ${mb(got)} MB…`),
    });
    if (!/^(image|video)\//.test(blob.type)) {
      throw new LoadError(`That link is not an image or video (${blob.type || 'unknown type'}). Use a direct link to the GIF or video file.`);
    }
    const name = url.split('?')[0].split('/').pop() || 'link';
    const n = await decode(new File([blob], name, { type: blob.type }), ctl);
    loadStatus(framesLabel(n), 'ok');
    log(framesLabel(n));
  } catch (e) {
    reportLoadError(e, ctl);
  } finally {
    endLoad(ctl);
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
      await mask.uploadImage(slots[i], toMaskBytes(imgs[i], layoutCfg), (p) => {
        prog.value = (i + p) / imgs.length;
      });
    }
    await mask.play(slots);
    log('Playing on mask');
  } catch (e) {
    log(explain(e), 'error');
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
$('eye').value = store.get('eyeLineRow') ?? EYE_LINE_Y;
$('eyeVal').textContent = $('eye').value;
$('eye').oninput = () => {
  $('eyeVal').textContent = $('eye').value;
  store.set('eyeLineRow', $('eye').value);
  if (showing === 'pattern') showPattern();
  else relayout();
};

// Mask layout controls: reflect the saved values, and save on change.
$('order').value = layoutCfg.order;
$('flipX').checked = layoutCfg.flipX;
$('flipY').checked = layoutCfg.flipY;
$('colors').value = layoutCfg.colors;
$('gamma').value = layoutCfg.gamma;
$('gVal').textContent = Number($('gamma').value).toFixed(1);
$('style').value = store.get('previewStyle') ?? 'mask';
const saveLayout = () => {
  layoutCfg.order = $('order').value;
  layoutCfg.flipX = $('flipX').checked;
  layoutCfg.flipY = $('flipY').checked;
  layoutCfg.colors = $('colors').value;
  layoutCfg.gamma = +$('gamma').value;
  store.set('layout', JSON.stringify(layoutCfg));
  trace('i', `layout: ${JSON.stringify(layoutCfg)}`);
};
['order', 'flipX', 'flipY', 'colors'].forEach((id) => ($(id).onchange = saveLayout));
$('gamma').oninput = () => {
  $('gVal').textContent = Number($('gamma').value).toFixed(1);
  saveLayout();
  redraw();
};
$('style').onchange = () => {
  store.set('previewStyle', $('style').value);
  redraw();
};
$('pattern').onchange = showPattern;
$('loadUrl').onclick = () => {
  if (loadCtl) loadCtl.abort(); // the button reads "Cancel" while a load is running
  else loadUrl($('url').value);
};
// Not `onkeydown = (e) => e.key === 'Enter' && ...`: an on* handler that returns
// false cancels the keystroke, which blocked typing, deleting and Ctrl+V.
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadUrl($('url').value);
  }
});

// Pasting: a copied image/GIF file, or text containing a link. Pasting a copied
// picture puts pixels on the clipboard (not a link), which a text box ignores
// silently, so handle it for the whole page and say what was found.
async function usePastedFile(file) {
  log(`Pasted ${file.type}`);
  if (!/^(image\/(gif|webp)|video\/)/.test(file.type)) {
    log('That is a still picture. To keep a GIF animated, paste its link or choose the file.');
  }
  await loadFile(file);
}

function usePastedText(text) {
  const link = extractUrl(text);
  if (!link) return false;
  $('url').value = link;
  loadUrl(link);
  return true;
}

document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...cd.files];
  trace('paste', `types=[${[...cd.types].join(', ')}] files=[${files.map((f) => f.type || f.name).join(', ')}]`);
  const media = files.find((f) => /^(image|video)\//.test(f.type));
  if (media) {
    e.preventDefault();
    usePastedFile(media);
  } else if (usePastedText(cd.getData('text/plain'))) {
    e.preventDefault();
  } else if (e.target !== $('url')) {
    log('Clipboard has no link, image or video');
  } // else: let a normal paste into the box happen
});
$('send').onclick = () => sendImages(sources.map((s) => renderFrame(s, mode(), eyeLine())));
$('test').onclick = () => {
  showPattern();
  sendImages([currentPattern()]);
};
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(traceLines.join('\n'));
    log('Diagnostics log copied');
  } catch {
    log('Could not copy automatically; select the text in Diagnostics instead');
  }
};

$('ver').textContent = APP_VERSION;

(async function logEnvironment() {
  trace('env', `Mask Cast ${APP_VERSION} layout=${JSON.stringify(layoutCfg)}`);
  trace('env', `secureContext=${isSecureContext} webBluetooth=${!!navigator.bluetooth}`);
  try {
    trace('env', `bluetooth available=${await navigator.bluetooth.getAvailability()}`);
  } catch { /* not supported */ }
  trace('env', navigator.userAgent);
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`SW: ${e.message}`));
}

// Samsung Internet and other non-Chrome Android browsers expose Web Bluetooth
// but never show the chooser.
if (/Android/.test(navigator.userAgent) && /SamsungBrowser|EdgA|OPR\/|Firefox|DuckDuckGo|MiuiBrowser|UCBrowser/.test(navigator.userAgent)) {
  $('chromeLink').href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  $('browserBanner').hidden = false;
}

// Opened via Share with a link: the service worker passed it along.
const sharedUrl = new URLSearchParams(location.search).get('sharedUrl');
if (sharedUrl) {
  $('url').value = sharedUrl;
  loadUrl(sharedUrl).then(() => history.replaceState(null, '', location.pathname));
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

relayout(); // shows the empty mask until something is loaded
updateUi();

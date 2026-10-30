import { LoadError, withTimeout } from './net.js';

const LOAD_MS = 10000; // a video must be ready this fast
const SEEK_MS = 8000;  // and each seek must finish this fast

// Resolves on `ev`, rejects on error or timeout, and always removes its listeners.
function waitFor(el, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      clearTimeout(timer);
      el.removeEventListener(ev, onOk);
      el.removeEventListener('error', onErr);
      fn(arg);
    };
    const onOk = () => finish(resolve);
    const onErr = () => finish(reject, new LoadError('This video could not be decoded (unsupported format?)'));
    const timer = setTimeout(() => finish(reject, new LoadError(`${what} took too long`)), ms);
    el.addEventListener(ev, onOk);
    el.addEventListener('error', onErr);
  });
}

// Returns up to n ImageBitmaps spread evenly across the clip (skipping the rest).
// The caller owns the bitmaps and should close() them when replaced.
// onProgress(i, n) is called while decoding; `signal` cancels; timeoutMs is the overall deadline.
export async function extractFrames(file, n, { onProgress = () => {}, signal, timeoutMs = 45000 } = {}) {
  const job = { stopped: false, bitmaps: [] };
  const cancelled = new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new LoadError('Cancelled', true)), { once: true });
  });
  try {
    const run = file.type.startsWith('video/') ? fromVideo(file, n, onProgress, job) : fromImage(file, n, onProgress, job);
    return await Promise.race([
      withTimeout(run, timeoutMs, 'Decoding took too long. Try a shorter or smaller file'),
      cancelled,
    ]);
  } catch (e) {
    job.stopped = true;
    job.bitmaps.forEach((b) => b.close());
    throw e;
  }
}

const checkStopped = (job) => {
  if (job.stopped) throw new LoadError('Cancelled', true);
};

async function fromImage(file, n, onProgress, job) {
  if (typeof ImageDecoder !== 'undefined') {
    try {
      return await fromImageDecoder(file, n, onProgress, job);
    } catch (e) {
      if (e instanceof LoadError) throw e;
      console.warn('ImageDecoder failed, using first frame', e);
      job.bitmaps.splice(0).forEach((b) => b.close());
    }
  }
  job.bitmaps.push(await createImageBitmap(file));
  return job.bitmaps;
}

async function fromImageDecoder(file, n, onProgress, job) {
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
  try {
    await dec.tracks.ready;
    const count = dec.tracks.selectedTrack.frameCount;
    const take = Math.min(n, count);
    for (let i = 0; i < take; i++) {
      checkStopped(job);
      onProgress(i + 1, take);
      const { image } = await dec.decode({ frameIndex: Math.floor((i * count) / take) });
      try {
        job.bitmaps.push(await createImageBitmap(image));
      } finally {
        image.close();
      }
    }
  } finally {
    dec.close();
  }
  return job.bitmaps;
}

async function fromVideo(file, n, onProgress, job) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  try {
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const ready = waitFor(v, 'loadeddata', LOAD_MS, 'Opening the video');
    v.src = url;
    await ready;
    if (!v.videoWidth) throw new LoadError('This video has no picture to show');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const cx = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      checkStopped(job);
      onProgress(i + 1, n);
      const t = (dur * (i + 0.5)) / n;
      if (Math.abs(v.currentTime - t) > 0.001) { // a seek to the current time never fires 'seeked'
        const seeked = waitFor(v, 'seeked', SEEK_MS, 'Seeking in the video');
        v.currentTime = t;
        await seeked;
      }
      cx.drawImage(v, 0, 0);
      job.bitmaps.push(await createImageBitmap(c));
    }
    return job.bitmaps;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

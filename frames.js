const once = (el, ev) => new Promise((res, rej) => {
  el.addEventListener(ev, res, { once: true });
  el.addEventListener('error', () => rej(new Error('Could not decode video')), { once: true });
});

// Returns up to n ImageBitmaps spread evenly across the clip (skipping the rest).
export async function extractFrames(file, n) {
  if (file.type.startsWith('video/')) return fromVideo(file, n);
  if (typeof ImageDecoder !== 'undefined') {
    try {
      return await fromImageDecoder(file, n);
    } catch (e) {
      console.warn('ImageDecoder failed, using first frame', e);
    }
  }
  return [await createImageBitmap(file)];
}

async function fromImageDecoder(file, n) {
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack.frameCount;
  const take = Math.min(n, count);
  const out = [];
  for (let i = 0; i < take; i++) {
    const { image } = await dec.decode({ frameIndex: Math.floor((i * count) / take) });
    out.push(await createImageBitmap(image));
    image.close();
  }
  dec.close();
  return out;
}

async function fromVideo(file, n) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await once(v, 'loadeddata');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const cx = c.getContext('2d');
    const out = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = (dur * (i + 0.5)) / n;
      await once(v, 'seeked');
      cx.drawImage(v, 0, 0);
      out.push(await createImageBitmap(c));
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

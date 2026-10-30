// Loading helpers that can't hang silently: every step has a deadline, can be
// cancelled, and fails with a message a person can act on.

export class LoadError extends Error {
  constructor(message, cancelled = false) {
    super(message);
    this.name = 'LoadError';
    this.cancelled = cancelled;
  }
}

export const mb = (bytes) => (bytes / 1e6).toFixed(1);

export function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LoadError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Downloads a link into a Blob, reporting progress. Gives up when no bytes arrive
// for idleMs, after totalMs overall, past maxBytes, or when `signal` aborts.
// Network/CORS failures are rethrown untouched (a TypeError) so the caller can explain them.
export async function fetchBlob(url, { signal, idleMs = 15000, totalMs = 90000, maxBytes = 50e6, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw new LoadError('Cancelled', true);
  const ctl = new AbortController();
  let reason = null; // why we aborted, when it was us
  const abort = (why) => {
    reason ??= why;
    ctl.abort();
  };
  const onOuterAbort = () => abort(new LoadError('Cancelled', true));
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let idle;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort(new LoadError(`No data arrived for ${Math.round(idleMs / 1000)} s, so I gave up`)), idleMs);
  };
  const overall = setTimeout(() => abort(new LoadError(`Download took longer than ${Math.round(totalMs / 1000)} s, so I gave up`)), totalMs);
  const tooBig = (n) => new LoadError(`That file is ${mb(n)} MB and the limit is ${mb(maxBytes)} MB. Try a smaller version`);

  try {
    bump();
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new LoadError(`The link returned HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > maxBytes) {
      ctl.abort();
      throw tooBig(declared);
    }
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      chunks.push(value);
      got += value.length;
      if (got > maxBytes) {
        ctl.abort();
        throw tooBig(got);
      }
      onProgress(got, declared);
    }
    return new Blob(chunks, { type });
  } catch (e) {
    if (e instanceof LoadError) throw e;
    if (reason) throw reason;
    throw e;
  } finally {
    clearTimeout(idle);
    clearTimeout(overall);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

// Network-first for app files (so updates show up immediately), falling back to
// the cache when offline. Bump CACHE if the file list changes.
const CACHE = 'mask-cast-v14';
const SHARE_CACHE = 'mask-cast-share';
const ASSETS = [
  './', './index.html', './app.js', './config.js', './frames.js', './layout.js',
  './mask.js', './mask-shape.js', './preview.js', './link.js', './net.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const home = (query = '') => Response.redirect(new URL(`./${query}`, self.registration.scope).href, 303);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await req.formData();
      const file = form.get('media');
      if (file && file.size) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          new URL('shared-file', self.registration.scope),
          new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
        );
        return home('?shared=1');
      }
      // A shared link arrives as text and/or url; take the first http(s) link.
      const link = `${form.get('url') ?? ''} ${form.get('text') ?? ''}`.match(/https?:\/\/\S+/);
      return link ? home(`?sharedUrl=${encodeURIComponent(link[0])}`) : home();
    })());
    return;
  }

  // Cross-origin requests (e.g. fetching a GIF link) go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});

// Bump CACHE when app files change so installed copies pick up the update.
const CACHE = 'mask-cast-v1';
const SHARE_CACHE = 'mask-cast-share';
const ASSETS = [
  './', './index.html', './app.js', './config.js', './frames.js', './layout.js',
  './mask.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const file = (await req.formData()).get('media');
      if (file) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          new URL('shared-file', self.registration.scope),
          new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
        );
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method === 'GET') {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
  }
});

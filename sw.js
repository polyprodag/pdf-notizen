// Service Worker: macht die App offline nutzbar und empfängt PDFs,
// die man aus anderen Apps (WhatsApp, Gmail, Dateien) an diese App "teilt".
const CACHE = 'pdf-notizen-v2';
const FILES = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
  './lib/pdf.min.js', './lib/pdf.worker.min.js', './lib/pdf-lib.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'shared-files').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Ein PDF wurde an die App geteilt
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('pdf');
        if (file) {
          const cache = await caches.open('shared-files');
          await cache.put('shared-file', new Response(file, {
            headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name || 'Dokument.pdf') },
          }));
        }
      } catch (err) { /* ignorieren, App öffnet sich trotzdem */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Erst aus dem Internet (damit Updates ankommen), sonst aus dem Speicher (offline)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

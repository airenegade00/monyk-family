// MONYK Family — Service Worker
// App-shell cache, verziozott cache-kulccsal (deploy utan automatikusan
// frissul, mert a regi verzioju cache torlodik az activate fazisban).

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'monyk-family-shell-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './Monyk-family.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: azonnal a cache-bol valaszol (ha van), kozben
// halkban frissiti a cache-t a halozatrol. Repulo uzemmodban a cache-bol
// mukodik tovabb.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN font/script marad halozatrol

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});

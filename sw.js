/* ============================================================
   Millis service worker

   Deliberately network-first for the app shell. A cache-first
   worker is faster but strands players on a stale build after a
   deploy, and this game ships changes constantly right now.
   Network-first keeps everyone current and still works offline.
   Bump CACHE when you want to guarantee old entries are dropped.
   ============================================================ */
const CACHE = 'millis-v1';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './core.js',
  './ads.js',
  './modes/blindstop.js',
  './modes/interval.js',
  './modes/estimate.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   /* a missing file must not break install */
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  /* same-origin only — never cache an ad or analytics request */
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

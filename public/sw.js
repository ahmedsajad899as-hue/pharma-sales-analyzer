// Ordine PWA Service Worker
const CACHE_NAME = 'ordine-v3';

// On install: activate immediately (skip waiting for old SW to die)
self.addEventListener('install', () => self.skipWaiting());

// On activate: claim all clients AND delete ALL old cache versions
self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
);

// Network-first strategy: always try network, fall back to cache for navigation
self.addEventListener('fetch', e => {
  const { request } = e;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // For navigation requests (HTML pages): network first, cache fallback
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then(r => r || caches.match('/')))
    );
    return;
  }

  // For API calls: always network only (never cache)
  if (request.url.includes('/api/')) return;

  // For static assets: NETWORK FIRST (ensures fresh assets after each deploy),
  // fall back to cache only when offline.
  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

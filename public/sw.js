// Ordine PWA Service Worker
const CACHE_NAME = 'ordine-v1';

// On install: activate immediately
self.addEventListener('install', () => self.skipWaiting());

// On activate: claim all clients
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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

  // For static assets: cache first, then network
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return res;
      });
    })
  );
});

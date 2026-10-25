// Ordine PWA Service Worker
const CACHE_NAME = 'ordine-v4';
const SHARE_CACHE = 'ordine-share';

// On install: activate immediately (skip waiting for old SW to die)
self.addEventListener('install', () => self.skipWaiting());

// On activate: claim all clients AND delete ALL old cache versions
self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== SHARE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
);

// Network-first strategy: always try network, fall back to cache for navigation
self.addEventListener('fetch', e => {
  const { request } = e;

  // Share target (manifest.json): صور مُشارَكة من تطبيق آخر (كروب المذخر بواتساب).
  // تُخزَّن في كاش منفصل، وصفحة «طلبيات المذاخر» تقرؤها لربطها بطلبية ثم تحذفها.
  if (request.method === 'POST' && new URL(request.url).pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const form = await request.formData();
        const files = form.getAll('images').filter(f => f && typeof f !== 'string');
        const cache = await caches.open(SHARE_CACHE);
        for (const k of await cache.keys()) await cache.delete(k);
        await Promise.all(files.map((f, i) => cache.put(`/shared-image/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'image/jpeg' } }))));
      } catch (_) { /* نتابع للتحويل على أي حال */ }
      return Response.redirect('/?share-target=1', 303);
    })());
    return;
  }

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

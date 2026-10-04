const CACHE_NAME = 'dypos-offline-v3.0';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Pre-caching non-fatal warning:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

/*
 * ══ TAKING AN UPDATE WHEN THE SHELL ASKS ══════════════════════════════════
 * The shell posts `{ type: 'SKIP_WAITING' }` after the operator confirms, so a
 * new worker is promoted without the page reloading mid-sale.
 *
 * This handler did not exist. The shell could therefore offer an update, and
 * pressing "apply" would do nothing at all: the message was ignored, the new
 * worker stayed in `waiting`, and the notice reappeared on the next reload —
 * looking like a button that is broken rather than a feature that is missing.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    // `self` inside a worker is the worker itself, so this activates THIS
    // worker immediately rather than the one waiting behind it.
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // Pass through API calls to network/server with fallback
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ offline: true, error: 'Network request failed in offline mode' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        );
      })
    );
    return;
  }

  // Stale-while-revalidate or Network-first for app shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

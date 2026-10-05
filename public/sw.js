/**
 * ══ CACHE NAME IS A VERSION ════════════════════════════════════════════════
 * Bumped to v4 together with the caching strategy below.
 *
 * It has to be bumped whenever the strategy changes, because `activate` deletes
 * every cache whose name is not this one. Without that, a till that has been
 * open since the previous release keeps serving the shell from the OLD
 * strategy's cache indefinitely.
 */
const CACHE_NAME = 'dypos-offline-v4.0';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  /*
   * The four weights × two subsets of IBM Plex Sans Arabic.
   *
   * They are pre-cached rather than left to first paint because a till that is
   * opened without a connection must still render in its real typeface. If the
   * family were only discovered by the stylesheet, an offline launch would
   * silently fall back to a system font — which is precisely the defect that
   * made the whole design look wrong on a live till.
   *
   * At roughly 258 KB total this is a deliberate trade: it is paid once, then
   * served from the cache forever. `index.html` already commits the browser to
   * downloading several hundred KB of JavaScript, so this is not what decides
   * whether the application opens.
   */
  '/fonts/arabic-400.woff2',
  '/fonts/latin-400.woff2',
  '/fonts/arabic-500.woff2',
  '/fonts/latin-500.woff2',
  '/fonts/arabic-600.woff2',
  '/fonts/latin-600.woff2',
  '/fonts/arabic-700.woff2',
  '/fonts/latin-700.woff2',
  /*
   * Tajawal, the heading face. Pre-cached for the same reason as the family
   * above: a heading is the first thing on every screen, and if it falls back
   * to a system font the hierarchy collapses on exactly the surfaces where a
   * cashier is deciding how fast to move.
   */
  '/fonts/tajawal-arabic-400.woff2',
  '/fonts/tajawal-latin-400.woff2',
  '/fonts/tajawal-arabic-500.woff2',
  '/fonts/tajawal-latin-500.woff2',
  '/fonts/tajawal-arabic-700.woff2',
  '/fonts/tajawal-latin-700.woff2',
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

  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * ══ CONTENT-HASHED ASSETS: CACHE-FIRST, AND CACHE PERMANENTLY ═════════════
   * A Vite build puts a content hash in the filename, so the URL changes the
   * moment the bytes change. The same URL therefore always means the same bytes,
   * and there is nothing to revalidate — which is exactly why the response
   * carries `immutable`. Cache-first here is correct and is what makes the app
   * open instantly at a till.
   */
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  /*
   * ══ EVERYTHING ELSE, INCLUDING THE SHELL: NETWORK-FIRST ═══════════════════
   * The previous handler was cache-first for every non-API request, and that is
   * what broke the site.
   *
   * `index.html` is NOT content-hashed — it is the file that names the hashed
   * files. Serving it from cache meant a till that had been open across a deploy
   * kept requesting the PREVIOUS build's asset names. Those assets are gone
   * (new hashes), so the Worker answered with `index.html` itself under
   * `not_found_handling = "single-page-application"`, served as `text/html`.
   *
   * The browser then refused it: "Refused to apply style ... MIME type
   * ('text/html') is not a supported stylesheet MIME type". The page rendered
   * unstyled and every subsequent asset failed the same way, and no amount of
   * retyping credentials would have helped.
   *
   * Network-first fixes it: the shell always names assets that exist, because
   * the shell came from the same deploy as those assets. The cache is still
   * used when the network is gone, which is the entire point of an offline till.
   */
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => {
        /*
         * Offline with nothing cached. A bare 503 here is a dead end for a
         * navigation request, so fall back to the shell, which `install`
         * pre-cached and which boots the app into its own offline handling.
         */
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return new Response('', { status: 503, statusText: 'Offline' });
      }))
  );
});

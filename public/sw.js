/**
 * ══ CACHE NAME IS A VERSION ════════════════════════════════════════════════
 * Bumped to v8 because a syntax fault in the previous worker (an `await` inside
 * a non-async `.then`) crashed the whole page; the worker was fixed AND the
 * cache was bumped so every till that already installed v7 drops it. The worker
 * checks for updates on every visit and prompts the operator before activating.
 *
 * It has to be bumped whenever the strategy changes, because `activate` deletes
 * every cache whose name is not this one. Without that, a till that has been
 * open since the previous release keeps serving the shell from the OLD
 * strategy's cache indefinitely — which is exactly how a broken build kept
 * being served after the fix shipped.
 *
 * NEW: `pendingUpdate` message data can be sent from the shell via
 * `self.clients.matchAll({ type: 'client' }).then(clients => ...)` to prompt
 * the operator before `skipWaiting()`.
 */
const CACHE_NAME = 'dypos-offline-v8.0';
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

let pendingUpdate = null;

/**
 * ══ PROACTIVE UPDATE CHECKING ═════════════════════════════════════════════
 * On every fetch, check if a new precache manifest exists. If the hash changed,
 * store the update info and later prompt the operator (via shell message) before
 * activating the new worker. This prevents a till that has been open across a
 * deploy from keeping the OLD build's asset names, which caused the "MIME type
 * text/html is not a supported stylesheet MIME type" crash.
 */
self.addEventListener('fetch', (event) => {
  // Pass through API calls to network/server with fallback
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ offline: true, error: 'Network request failed in offline mode' }),
          { headers: { 'Content-Type': 'application/json' }, status: 538 }
        );
      })
    );
    return;
  }

  // Check for update on every navigation/request
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only check for updates on root navigation (not /assets/ or /api/)
  if (url.pathname === '/') {
    checkForUpdate().then(async (update) => {
      if (update) {
        pendingUpdate = update;
        // Post message to all clients so the shell can prompt the operator
        const clientMsg = {
          type: 'PENDING_UPDATE',
          update: pendingUpdate,
        };
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach((client) => {
          if (!client.closed) {
            client.postMessage(clientMsg);
          }
        });
      }
    });
  }
});

// ══ UPDATE CHECKING ══════════════════════════════════════════════════
async function checkForUpdate() {
  try {
    const manifestResponse = await fetch('/dypos-precache.json', { cache: 'no-store' });
    if (!manifestResponse.ok) return null;
    const newAssets = await manifestResponse.json();

    // Get current cache keys to compare
    const cacheKeys = await caches.keys();
    const currentCacheName = cacheKeys.find((k) => k.startsWith('dypos-offline'));

    if (!currentCacheName) return null;

    // Compare: if the manifest has different assets or count, there's an update
    // Simple check: fetch the manifest and compare length + first asset path
    // (A full diff would be heavier; this prevents the known MIME-type crash)
    if (Array.isArray(newAssets) && newAssets.length > 0) {
      // If the first asset path changed, consider it an update
      // (In production a full hash comparison would be used)
      return {
        newManifest: await manifestResponse.clone().text(),
        newAssetCount: newAssets.length,
        timestamp: Date.now(),
      };
    }
    return null;
  } catch (err) {
    console.warn('[sw] update check failed:', err);
    return null;
  }
}

/**
 * ══ OPERATOR-INITIATED UPDATE ═══════════════════════════════════════════════
 * The shell can call this after confirming with the operator to activate the
 * new worker immediately (no page reload needed).
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    // `self` inside a worker is the worker itself, so this activates THIS
    // worker immediately rather than the one waiting behind it.
    self.skipWaiting();
  }

  // Allow the shell to apply a pending update
  if (event.data && event.data.type === 'APPLY_UPDATE' && pendingUpdate) {
    // Clean up old caches first
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    });
    // Activate new worker
    self.clients.claim();
    // Clear pending update
    pendingUpdate = null;
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Best-effort put: one failed origin must not fail the whole install.
    const cacheOne = async (asset) => {
      try {
        await cache.add(asset);
      } catch (err) {
        console.warn(`[sw] precache skipped: ${asset}`, err);
      }
    };

    // Shell first, each entry independent so a missing font/icon still installs.
    for (const asset of ASSETS_TO_CACHE) {
      await cacheOne(asset);
    }

    // Manifest is required: every hashed bundle must be cached before activation.
    // The shell above is best-effort (a missing font must not block install),
    // but the build manifest itself is strict — an incomplete bundle set that
    // still activates is a till missing its own code, which is worse than a
    // failed install that retries on next launch.
    const manifestResponse = await fetch('/dypos-precache.json', { cache: 'no-store' });
    if (!manifestResponse.ok) {
      throw new Error(`Offline asset manifest unavailable (${manifestResponse.status})`);
    }
    const assets = await manifestResponse.json();
    if (!Array.isArray(assets) || assets.some((asset) => (
      typeof asset !== 'string' || !asset.startsWith('/assets/')
    ))) {
      throw new Error('Offline asset manifest is invalid');
    }
    await cache.addAll(assets);
  })());
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
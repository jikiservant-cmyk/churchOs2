/* churchOs service worker.
 *
 * What this replaces: a worker that pre-cached '/' and answered EVERY request
 * cache-first. That is actively harmful for this app:
 *
 *   - '/' cached at install is the signed-out landing page, so a returning
 *     admin could be served it forever;
 *   - cache-first on /api/* would replay stale JSON — attendance counts,
 *     wallet balances — with no way for the page to notice;
 *   - it never updated, because nothing deleted the old cache.
 *
 * The rules here are deliberately conservative. A church office runs this on
 * cheap Android phones over metered connections, so the offline shell is worth
 * having; stale data is not.
 *
 *   navigations      network-first, cached copy as offline fallback
 *   build output     cache-first (/_next/static is content-hashed, immutable)
 *   icons/fonts      stale-while-revalidate
 *   everything else  untouched — no interception at all
 *
 * API and auth requests are never cached and never intercepted. Church
 * management data must be live or fail visibly.
 */

const VERSION = 'v2';
const SHELL_CACHE = `churchos-shell-${VERSION}`;
const ASSET_CACHE = `churchos-assets-${VERSION}`;
const OFFLINE_URL = '/offline';

// Precached at install. Deliberately small: the app shell, the offline page and
// the icons the manifest references. Any of these failing should not abort the
// install, so each is added individually.
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            /* a missing asset must not block activation */
          })
        )
      );
      // Take over as soon as possible; there is no long-lived state to protect.
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('churchos-') && !keep.has(n)).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

function isApi(pathname) {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_next/webpack-hmr')
  );
}

function isBuildAsset(pathname) {
  return pathname.startsWith('/_next/static/');
}

function isCacheableAsset(pathname) {
  return (
    /\.(?:png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|otf|eot)$/i.test(pathname) ||
    pathname.startsWith('/icons/')
  );
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Only keep a successful, same-origin HTML response. Caching a redirect to
    // /login would strand the user on it offline.
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Any other page requested offline falls back to the offline screen rather
    // than the browser's dinosaur.
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="font-family:system-ui;padding:2rem;text-align:center">' +
        '<h1>You are offline</h1><p>Reconnect to continue.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET. A POST/PATCH must always reach the server or fail in the app's
  // own error handling — replaying one from a cache would be a data bug.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch another origin, and never touch the API or auth.
  if (url.origin !== self.location.origin) return;
  if (isApi(url.pathname)) return;

  // Navigations: network-first so a signed-in user always sees fresh HTML.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isBuildAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isCacheableAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }

  // Everything else (RSC payloads, dynamic chunks) goes to the network
  // untouched. Next.js does its own caching and knows better than we do.
});

// Let the page trigger an update when it detects a new build.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

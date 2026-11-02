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
 *   navigations      network-first; only PUBLIC pages keep a cached copy
 *   build output     cache-first (/_next/static is content-hashed, immutable)
 *   icons/fonts      stale-while-revalidate
 *   everything else  untouched — no interception at all
 *
 * API and auth requests are never cached and never intercepted. Church
 * management data must be live or fail visibly.
 */

// v3: private navigations are no longer cached at all (see isPublicPage), and the
// version bump is what makes every previously installed v2 shell cache — which may
// hold a member roster someone else can open offline — get deleted on activate.
const VERSION = 'v3';
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

/**
 * The only pages allowed into the offline shell cache.
 *
 * Default-deny, because Cache Storage is not a secret store: anything written here
 * stays readable from devtools, and stays readable after logout, on the shared church
 * tablet (sign-out clears the cookie, not this cache). Everything the app actually
 * holds under app/ that is not listed here belongs to somebody — /c/<slug>/**,
 * /admin/**, /applet/app/**, /overseer/**, /super-admin/**, /messages/**, and every
 * /api/** response — so a page has to be *known* public to be kept.
 *
 * A new public marketing page is therefore not cached offline until it is added
 * here, and the fallback for it is /offline. That is the smaller wrong: the cost of
 * forgetting one is a duller offline page, the cost of forgetting to exclude a
 * private one is someone else's member roster.
 *
 * tests/pwa.test.ts asserts every top-level route in app/ is either listed here
 * or refused, so this list cannot drift away from the app silently.
 */
const PUBLIC_OFFLINE_PATHS = new Set([
  OFFLINE_URL,
  '/',
  '/login',
  '/signup',
  '/denominations',
  '/d',
]);

function isPublicPage(request) {
  let path = '/';
  try {
    path = new URL(request.url).pathname || '/';
  } catch {
    return false;
  }
  // Normalise the trailing slash so /login/ is the same page as /login, but treat
  // anything deeper than one segment as not-public: there is no public route here
  // with a sub-path, and /c/ekero must never match a hypothetical '/c/'.
  const normalised = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return PUBLIC_OFFLINE_PATHS.has(normalised === '' ? '/' : normalised);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Only keep a successful, same-origin HTML response. Caching a redirect to
    // /login would strand the user on it offline.
    //
    // And only for public pages. Everything under a church workspace is per-user
    // data, and Cache Storage is not a secret store: a roster page put there stays
    // readable from DevTools, and stays readable after logout, on the shared church
    // tablet — logout clears the cookie, not this cache. Offline access to member
    // data was never a requirement; serving the offline shell instead is the point.
    if (response.ok && response.type === 'basic' && isPublicPage(request)) {
      cache.put(request, response.clone());
    } else if (response.ok && !isPublicPage(request)) {
      // Drop anything a pre-v3 worker left behind for this URL.
      cache.delete(request);
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

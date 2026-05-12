// T34.3 — ARISE Fitness System service worker.
//
// Goal: when the user installs the site to their Home Screen (iOS/Android),
// future deploys should be picked up automatically. Pre-SW behavior: iOS
// would cache the HTML at install time and never refresh it — users had to
// delete and re-add the icon to see new code.
//
// Strategy:
//   - HTML (the app shell)        → network-first, fall back to cache
//   - Static assets (logos, video) → cache-first, fall back to network
//   - Cross-origin (API, CDN)     → bypass (always go to network)
//
// Bump CACHE_VERSION whenever you want to force-clear old caches on activate.
// (Network-first already serves fresh code when online, but the version bump
// catches the rare case where a corrupted cache entry sticks around.)

const CACHE_VERSION = 'arise-v1.0.1';
const CACHE_NAME = `${CACHE_VERSION}-shell`;

// Pre-cache the app shell on install so the app works offline immediately
// after install. Network-first fetch will keep these fresh thereafter.
// NOTE: only list paths that are ACTUALLY deployed. The dev file
// ARISE_Fitness_System.html lives only in the source repo; the live site
// serves it as index.html. Any 404 here triggers a soft warning via the
// try/catch in the install handler, but it's cleaner to omit phantom paths.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/arise-logo-mark.svg',
  '/arise-logo.png',
  '/arise-logo-inline.svg',
  '/arise-logo-stacked.svg',
];

// Hostnames we should NEVER cache — these must always hit the live network.
// Includes Supabase (cloud sync + auth), Anthropic proxy (ARIA), Strava OAuth,
// Open Food Facts (food lookup), YouTube (demo videos), Google Fonts.
const NEVER_CACHE_HOSTS = [
  'supabase.co',
  'supabase.in',
  'anthropic.com',
  'strava.com',
  'openfoodfacts.org',
  'youtube.com',
  'youtu.be',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// File extensions / patterns considered "static asset" for cache-first.
const STATIC_ASSET_PATTERN = /\.(svg|png|jpg|jpeg|webp|gif|ico|mp4|webm|woff2?|ttf|otf)$/i;
// Patterns considered "app shell" (HTML) for network-first.
const APP_SHELL_PATTERN = /\.html?$/i;

self.addEventListener('install', (event) => {
  // Skip waiting so the new SW takes over as soon as the old one releases its
  // grip — combined with clients.claim() on activate, this minimizes the
  // window where the user runs mixed-version code across tabs.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll() is all-or-nothing — if any one URL 404s the install fails.
      // We tolerate individual misses by adding each one independently.
      return Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] pre-cache skip', url, err && err.message);
          })
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Delete every cache namespace that isn't the current one.
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      ),
      // Take control of any clients (open tabs) immediately, without waiting
      // for them to reload first. Combined with skipWaiting, this means the
      // next fetch after activation goes through us.
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET. POST/PUT/etc. bypass entirely.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Bypass for cross-origin destinations we should never cache.
  if (NEVER_CACHE_HOSTS.some((host) => url.hostname.includes(host))) return;
  // Bypass for anything that isn't http(s). Don't try to handle chrome-extension://, data:, etc.
  if (!url.protocol.startsWith('http')) return;
  // Same-origin only past this point — third-party CDNs (jsDelivr) can be
  // intercepted but we'll just network-fetch them without caching to avoid
  // bloat. Most fall under STATIC_ASSET_PATTERN already.
  const sameOrigin = url.origin === self.location.origin;
  if (APP_SHELL_PATTERN.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(networkFirst(req));
  } else if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(sameOrigin ? cacheFirst(req) : networkPassthrough(req));
  } else {
    // Anything else same-origin → network-first (rare, e.g. JSON config blobs)
    event.respondWith(sameOrigin ? networkFirst(req) : networkPassthrough(req));
  }
});

// Network-first: try the network with a 4s timeout, fall back to cache on
// failure or timeout. Successful responses are cached for offline fallback.
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkResp = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    // Only cache successful, basic responses (not opaque cross-origin)
    if (networkResp && networkResp.ok && networkResp.type === 'basic') {
      try { await cache.put(req, networkResp.clone()); } catch (e) {}
    }
    return networkResp;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-ditch fallback for root or HTML — serve the cached app shell
    if (APP_SHELL_PATTERN.test(req.url) || req.url.endsWith('/')) {
      const shell = await cache.match('/') || await cache.match('/index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

// Cache-first: serve from cache instantly if present. If not, fetch and cache.
// Background refresh is intentionally omitted to keep memory pressure low on
// iOS — the user can pull-to-refresh if they want a fresh logo asset.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const networkResp = await fetch(req);
    if (networkResp && networkResp.ok && networkResp.type === 'basic') {
      try { await cache.put(req, networkResp.clone()); } catch (e) {}
    }
    return networkResp;
  } catch (err) {
    // No cache + network failed — return whatever we can or rethrow
    throw err;
  }
}

// Pass-through: cross-origin same-as-no-SW. We don't cache or modify.
function networkPassthrough(req) {
  return fetch(req);
}

// Message handler — lets the page request a hard skip-waiting if the user
// taps an "Update now" prompt. (Future-friendly; currently auto-skipWaiting
// fires on install so this is mostly a no-op.)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

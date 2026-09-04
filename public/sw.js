/* Service worker.
 *
 * Two jobs, and deliberately not a third:
 *   1. The shell — HTML, CSS, JS, icons — is served from cache and refreshed in
 *      the background, so a repeat visit paints before the network answers.
 *      Karachi to Seoul is a long way and the first paint should not wait for it.
 *   2. Product photographs are cached as they are seen. The swipe deck shows the
 *      same card again on the way back through, and a WebP that has already been
 *      downloaded should never be downloaded twice.
 *
 * It does NOT cache API responses. Prices, stock and order status must be
 * current — a cached "in stock" that is not is worse than a slow page, and a
 * cached order status is exactly the thing a worried buyer is refreshing for.
 */
const VERSION = 'nova-v9';
const SHELL = `${VERSION}-shell`;
const PHOTOS = `${VERSION}-photos`;

/* Relative on purpose: the site is served from /nova-marketplace/ on GitHub
   Pages and from the root on Cloudflare. */
const SHELL_FILES = [
  './', './index.html', './seller.html', './admin.html', './config.js',
  './css/app.css', './css/motion.css', './css/seller.css',
  './js/app.js', './js/api.js', './js/store.js', './js/ui.js', './js/views.js',
  './js/deck.js', './js/checkout.js', './js/motion.js', './js/shop.js',
  './js/account.js', './js/browse.js', './js/money.mjs',
  './favicon.svg', './icon-192.png', './site.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if ONE file 404s, which would leave the
    // worker never activating and the failure invisible. One at a time, and a
    // missing file is a warning rather than a broken install.
    await Promise.all(SHELL_FILES.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not cache', url, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, PHOTOS]);
    await Promise.all((await caches.keys()).filter(k => !keep.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isPhoto = url =>
  url.pathname.includes('/storage/v1/object/public/product-photos/') ||
  url.pathname.endsWith('.webp') || url.pathname.endsWith('.svg');

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never the API. See the note at the top.
  if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/')) return;

  if (isPhoto(url)) {
    // Cache first: a photograph at a given key never changes — the key carries
    // a random id, so a new photo is a new URL.
    event.respondWith((async () => {
      const cache = await caches.open(PHOTOS);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  /* Shell: network first, cache as the safety net.
   *
   * Stale-while-revalidate is the usual advice and it is wrong here. It serves
   * the previous version and refreshes for next time, so every deploy lands one
   * visit late — and during development it quietly serves yesterday's CSS while
   * you wonder why a change did nothing. That cost a debugging round.
   *
   * Network-first still gives the offline behaviour that matters, and the race
   * below means a slow connection falls back to cache after 2.5s rather than
   * hanging: what the shopper sees is a fast app, not a stale one.
   */
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request).then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    });

    if (!cached) {
      try { return await network; } catch { return cache.match('./index.html'); }
    }

    const slow = new Promise(resolve => setTimeout(() => resolve(null), 2500));
    try {
      return (await Promise.race([network, slow])) || cached;
    } catch {
      return cached;
    }
  })());
});

/* The page can ask for a hard refresh after a deploy. */
self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

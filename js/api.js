/* The one place the app talks to data.
 *
 * Two backends behind one interface:
 *   fixtures  — public/data/catalog.json, the demo catalogue
 *   live      — the Supabase project, through PostgREST
 *
 * Every function returns the same shape from either, so no screen knows which
 * one it is on. Which is used is `BUYER_BACKEND` in config.js and nothing else —
 * deliberately not "is a Supabase URL configured", because the seller workspace
 * needs the project long before the buyer app is ready for it.
 */
import { store, isLiveId } from './store.js';
import { account } from './account.js';

const cfg = () => window.NOVAMKT;
const live = () => cfg().BUYER_BACKEND === 'live' && !!cfg().SUPABASE_URL;

/* ------------------------------------------------------------------ live --- */

async function rpc(name, args = {}, retry = true) {
  const res = await fetch(new URL(`/rest/v1/rpc/${name}`, cfg().SUPABASE_URL), {
    method: 'POST',
    headers: {
      apikey: cfg().SUPABASE_ANON_KEY,
      // A signed-in buyer's token when there is one, so auth.uid() is set and
      // place_order stamps the order with the account. Anonymous browsing keeps
      // using the publishable key, unchanged.
      authorization: `Bearer ${account.token || cfg().SUPABASE_ANON_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  // Access tokens last an hour; refresh once rather than logging someone out
  // in the middle of a checkout.
  if (res.status === 401 && retry && account.signedIn) {
    try { await account.refresh(); return rpc(name, args, false); } catch { /* fall through */ }
  }
  if (!res.ok) {
    const body = await res.text();
    let message = `${name} failed`;
    try { message = JSON.parse(body).message || message; } catch { /* keep the default */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  // Some of these return void — buyer_read and seller_read mark a thread read
  // and answer 204 with no body. res.json() throws on an empty response, so
  // read the text and only parse when there is something to parse.
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* Photographs are stored as object keys, not URLs, so that moving the bucket to
   R2 later changes this one line and nothing else. The three variants are an
   implementation detail of serving; the app asks for a size. */
const PHOTO_BASE = () => `${cfg().SUPABASE_URL}/storage/v1/object/public/product-photos`;
const photoUrls = keys => (keys || []).map(k => `${PHOTO_BASE()}/${k}-card.webp`);

/* Live rows arrive with `photo_keys`; fixtures arrive with ready-made relative
   paths. Both leave here as `photos`, a plain array of URLs. */
const fromLive = p => p && ({ ...p, photos: photoUrls(p.photo_keys) });

/* The device's seen-ledger runs to thousands of ids. Sending all of them on
   every deck request would cost more than the page it fetches, so the server
   gets the most recent slice and the client filters whatever slips past against
   its full copy. Cheap at both ends, and correct at both ends. */
const SEEN_TO_SEND = 250;

/* -------------------------------------------------------------- fixtures --- */

let cache = null;
async function catalog() {
  if (!cache) {
    // Relative, not absolute: the site is served from a subpath on GitHub Pages
    // and from the root on Cloudflare. Hash routing means the document URL
    // never changes, so a relative path resolves correctly in both.
    const res = await fetch('data/catalog.json');
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    cache = await res.json();
    cache.bySeller = new Map(cache.sellers.map(s => [s.id, s]));
    cache.byId = new Map(cache.products.map(p => [p.id, p]));
  }
  return cache;
}

const hydrate = (c, p) => ({ ...p, seller: c.bySeller.get(p.seller_id) });

/* Ranking for the fixture backend, mirroring deck() in
   20260904110001_buyer_reads.sql. Interest overlap first, then promotion, then
   freshness, then a deterministic jitter. */
function rank(products, { interests = [], seen = new Set() }) {
  const jitter = id => (([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0) % 1000) / 1250;
  const now = Date.now();
  return products
    .filter(p => p.status === 'live' && !seen.has(p.id))
    .map(p => ({
      p,
      score: (interests.includes(p.interest) ? 3 : 0)
           + (p.promoted ? 1.5 : 0)
           + Math.max(0, 1 - (now - Date.parse(p.created_at)) / 7776000000) * 1.2
           + jitter(p.id)
    }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);
}

/* ------------------------------------------------------------------- api --- */

export const api = {
  async meta() {
    const interests = [
      { id: 'clothing', label: 'Clothing', hint: 'Everyday, festive, handmade' },
      { id: 'sports', label: 'Sport', hint: 'Training, outdoors, gear' },
      { id: 'food', label: 'Food', hint: 'Pantry, chai, gifting' },
      { id: 'magazines', label: 'Print', hint: 'Zines, journals, collectibles' }
    ];
    if (live()) {
      const front = await rpc('storefront');
      return { interests, cities: cfg().CITIES, sellers: front.sellers, liveProducts: front.live_products };
    }
    const c = await catalog();
    return { interests: c.interests, cities: c.cities, sellers: c.sellers };
  },

  async deck({ limit = cfg().DECK_PAGE, offset = 0 } = {}) {
    const { interests, seen } = store.get();
    if (live()) {
      const page = await rpc('deck', {
        p_interests: interests,
        // Belt and braces on top of the purge in store.js: one id of the wrong
        // shape makes Postgres reject the whole call, and a deck that will not
        // load is a far worse failure than a card shown twice.
        p_seen: seen.filter(isLiveId).slice(-SEEN_TO_SEND),
        p_limit: limit,
        p_offset: offset
      });
      const set = new Set(seen);
      return { items: page.items.map(fromLive).filter(p => !set.has(p.id)), remaining: page.remaining };
    }
    const c = await catalog();
    const ranked = rank(c.products, { interests, seen: new Set(seen) });
    return {
      items: ranked.slice(offset, offset + limit).map(p => hydrate(c, p)),
      remaining: Math.max(0, ranked.length - offset - limit)
    };
  },

  async browse({ interest = null, limit = 60, offset = 0, filters = {} } = {}) {
    if (live()) {
      const out = await rpc('browse', {
        p_interest: interest, p_limit: limit, p_offset: offset,
        p_category: filters.category ?? null,
        p_min_price: filters.min ?? null, p_max_price: filters.max ?? null,
        p_city: filters.city ?? null, p_condition: filters.condition ?? null,
        p_size: filters.size ?? null, p_on_sale: !!filters.onSale,
        p_sort: filters.sort ?? 'new'
      });
      return { items: out.items.map(fromLive), total: out.total, facets: out.facets };
    }
    const c = await catalog();
    const items = c.products
      .filter(p => p.status === 'live' && (!interest || p.interest === interest))
      .sort((a, b) => (b.promoted === true) - (a.promoted === true) || Date.parse(b.created_at) - Date.parse(a.created_at));
    return { items: items.slice(offset, offset + limit).map(p => hydrate(c, p)), total: items.length };
  },

  async search(q) {
    if (live()) {
      const out = await rpc('search_products', { p_q: q, p_limit: 60 });
      return { items: out.items.map(fromLive) };
    }
    // Stands in for the Postgres full-text + trigram search. Deliberately never
    // `ilike '%q%'`, which cannot use an index and degrades the moment the
    // catalogue is real.
    const c = await catalog();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { items: [] };
    const items = c.products
      .filter(p => p.status === 'live')
      .map(p => {
        const hay = `${p.title} ${p.tags.join(' ')} ${c.bySeller.get(p.seller_id).brand_name} ${p.city} ${p.interest}`.toLowerCase();
        const hits = terms.filter(t => hay.includes(t)).length;
        const titleHits = terms.filter(t => p.title.toLowerCase().includes(t)).length;
        return { p, score: hits + titleHits * 2 };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map(x => hydrate(c, x.p));
    return { items };
  },

  async product(id) {
    if (live()) {
      // A bookmarked fixture id, or a hand-typed URL. Answer "gone" rather than
      // throwing a 400 the screen cannot do anything with.
      if (!isLiveId(id)) return null;
      return fromLive(await rpc('product_json', { p_id: id }));
    }
    const c = await catalog();
    const p = c.byId.get(id);
    return p ? hydrate(c, p) : null;
  },

  async products(ids) {
    if (!ids.length) return [];
    if (live()) {
      const usable = ids.filter(isLiveId);
      if (!usable.length) return [];
      return (await rpc('products_by_id', { p_ids: usable })).map(fromLive);
    }
    const c = await catalog();
    return ids.map(id => c.byId.get(id)).filter(Boolean).map(p => hydrate(c, p));
  },

  /* The account. */
  async registerBuyer(name, email, phone) {
    account.profile = await rpc('register_buyer', { p_name: name, p_email: email, p_phone: phone });
    return account.profile;
  },
  async meBuyer() {
    if (!account.signedIn) return null;
    account.profile = await rpc('me_buyer');
    return account.profile;
  },
  async myOrders() {
    if (!account.signedIn) return [];
    return rpc('my_orders');
  },
  async myOrder(code) {
    if (!account.signedIn) return null;
    return rpc('my_order', { p_code: code });
  },

  async categories() {
    if (!live()) return [];
    return rpc('category_tree');
  },
  async banners() {
    if (!live()) return [];
    return rpc('banners_for', { p_where: 'browse' });
  },
  async suggestions(q = null) {
    if (!live()) return { popular: [], trending: [], matches: [] };
    return rpc('search_suggestions', { p_q: q });
  },
  recordSearch(q, found) {
    if (!live()) return;
    rpc('record_search', { p_q: q, p_found: found }).catch(() => {});
  },
  async related(productId) {
    if (!live()) return [];
    return (await rpc('related', { p_product: productId, p_limit: 6 })).map(fromLive);
  },

  async trending() {
    if (!live()) return [];
    return (await rpc('trending', { p_limit: 40 })).items.map(fromLive);
  },

  async offers() {
    if (live()) return (await rpc('offers', { p_limit: 60 })).items.map(fromLive);
    // Fixtures have no sale prices; the tab is honest about being empty.
    return [];
  },

  async shop(id) {
    if (!live()) return null;
    const s = await rpc('shop', { p_seller: id, p_limit: 60 });
    return s && { ...s, products: s.products.map(fromLive) };
  },

  async reviews(productId) {
    if (!live()) return [];
    return rpc('product_reviews', { p_product: productId, p_limit: 20 });
  },

  async reviewable(code, phone) {
    if (!live()) return [];
    return rpc('reviewable', { p_code: code, p_phone: phone });
  },

  async leaveReview(code, phone, productId, rating, body) {
    if (!live()) return { ok: true };
    return rpc('leave_review', { p_code: code, p_phone: phone, p_product: productId, p_rating: rating, p_body: body });
  },

  async cancelWindow(code, phone) {
    if (!live()) return { can_cancel: false, seconds_left: 0 };
    return rpc('cancel_window', { p_code: code, p_phone: phone });
  },

  async cancelOrder(code, phone) {
    if (!live()) throw new Error('Cancelling needs the live backend.');
    return rpc('cancel_order', { p_code: code, p_phone: phone });
  },

  /* Messaging. The device id is the buyer's whole identity here — see
     20260904160002_messaging.sql for why, and what replaces it if buyer
     accounts ever arrive. */
  msg: {
    async threads() {
      if (!live()) return [];
      return rpc('buyer_threads', { p_device: store.deviceId() });
    },
    async thread(id) {
      if (!live()) return null;
      return rpc('buyer_thread', { p_device: store.deviceId(), p_thread: id });
    },
    async open({ sellerId, productId = null, name = null, body = null }) {
      if (!live()) throw new Error('Messages need the live backend.');
      return rpc('buyer_open_thread', {
        p_device: store.deviceId(), p_seller: sellerId,
        p_product: productId, p_name: name, p_body: body
      });
    },
    async send(threadId, body) {
      if (!live()) throw new Error('Messages need the live backend.');
      return rpc('buyer_send', { p_device: store.deviceId(), p_thread: threadId, p_body: body });
    },
    async read(threadId) {
      if (!live()) return;
      return rpc('buyer_read', { p_device: store.deviceId(), p_thread: threadId });
    }
  },

  async sellers() {
    if (live()) return (await rpc('storefront')).sellers;
    return (await catalog()).sellers;
  },

  /* Placing an order.
   *
   * Live, this is one Postgres transaction that re-reads prices and stock, so
   * the browser sends ids and quantities and never a price — a price that came
   * from a browser is a price an attacker chose. The client-side arithmetic in
   * checkout.js is for showing the buyer what they are agreeing to.
   */
  async placeOrder(order) {
    if (live()) {
      return rpc('place_order', {
        payload: {
          contact: order.contact,
          express: order.express,
          payment: order.payment,
          lines: order.lines
        }
      });
    }
    const key = 'nova.orders.v1';
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[order.code] = order;
    localStorage.setItem(key, JSON.stringify(all));
    return order;
  },

  /* Reading an order back needs the phone as well as the code — a guessed or
     shoulder-surfed code on its own must reveal nothing. */
  async order(code, phone = null) {
    if (live()) {
      try {
        // Signed in, the account is a stronger claim than a phone number, so
        // the code alone is enough for an order that belongs to them.
        if (account.signedIn) {
          const mine = await rpc('my_order', { p_code: code });
          if (mine) return mine;
        }
        return await rpc('get_order', { p_code: code, p_phone: phone });
      } catch { return null; }
    }
    const all = JSON.parse(localStorage.getItem('nova.orders.v1') || '{}');
    const found = all[String(code || '').trim().toUpperCase()] || null;
    if (!found) return null;
    if (phone !== null && found.contact.phone !== phone) return null;
    return found;
  },

  async reportListing(productId, reason, detail = '') {
    if (!live()) return { already: false };
    return rpc('report_listing', {
      p_product: productId, p_device: store.deviceId(), p_reason: reason, p_detail: detail
    });
  },

  /* Impressions and swipes are buffered and flushed in batches — one row per
     product per day server-side, never one row per view. A 500 MB free-tier
     database will not survive raw event logging, and the seller only ever sees
     the daily number anyway. */
  /* Site-wide measurement, separate from per-product stats.
     Same discipline: buffered, batched, counters not logs, and never allowed
     to break anything it is measuring. */
  site: (() => {
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      if (!live()) { console.debug('[site]', batch.map(e => e.metric).join(',')); return; }
      fetch(new URL('/rest/v1/rpc/record_site', cfg().SUPABASE_URL), {
        method: 'POST', keepalive: true,
        headers: {
          apikey: cfg().SUPABASE_ANON_KEY,
          authorization: `Bearer ${account.token || cfg().SUPABASE_ANON_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ events: batch })
      }).catch(() => { /* measurement must never break a purchase */ });
    };
    setInterval(flush, 10000);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    addEventListener('pagehide', flush);
    return (metric, detail = '') => {
      buffer.push({ metric, detail: String(detail).slice(0, 60) });
      if (buffer.length >= 40) flush();
    };
  })(),

  track: (() => {
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      if (!live()) { console.debug('[track]', batch.length, 'events'); return; }

      // fetch with keepalive, NOT navigator.sendBeacon.
      //
      // sendBeacon looks like the right tool — it is built for exactly this —
      // but it cannot send `application/json` cross-origin: that content type
      // is not CORS-safelisted, so the request needs a preflight and a beacon
      // cannot perform one. It returns true, queues nothing, and the numbers
      // silently never arrive. keepalive gives the same survives-the-unload
      // behaviour through a normal, preflightable request.
      fetch(new URL('/rest/v1/rpc/record_events', cfg().SUPABASE_URL), {
        method: 'POST',
        keepalive: true,
        headers: {
          apikey: cfg().SUPABASE_ANON_KEY,
          authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ events: batch })
      }).catch(() => { /* analytics must never break a purchase */ });
    };

    setInterval(flush, 10000);
    // Three triggers, because each misses a case the others catch:
    //   visibilitychange  the tab is backgrounded — the common one on a phone
    //   pagehide          the page is actually going away, including a
    //                     same-tab navigation, which visibilitychange does NOT
    //                     fire for. Without it the last buffer of every session
    //                     was silently dropped.
    //   the interval      everything else, for a long session on one screen
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    addEventListener('pagehide', flush);
    return (type, product_id) => {
      buffer.push({ type, product_id });
      if (buffer.length >= 50) flush();
    };
  })()
};

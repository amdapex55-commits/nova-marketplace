/* The one place the app talks to data.
 *
 * Two backends behind one interface:
 *   fixtures  — public/data/catalog.json, used while SUPABASE_URL is empty
 *   postgrest — Supabase, once Phase 0 exists
 *
 * Every function returns the same shape from either, so no screen knows which
 * one it is on. Swapping is a URL in config.js, not a rewrite.
 */
import { store } from './store.js';

const cfg = () => window.NOVAMKT;
/* A real Supabase project now exists and seller.html uses it — but the buyer
   app's read path still comes from fixtures, so this must not key off the URL
   being present. See BUYER_BACKEND in config.js. */
const live = () => cfg().BUYER_BACKEND === 'live' && !!cfg().SUPABASE_URL;

let cache = null;
async function catalog() {
  if (!cache) {
    // Relative, not absolute: the site is served from a subpath on GitHub Pages
    // (/nova-marketplace/) and from the root on Cloudflare. Hash routing means
    // the document URL never changes, so a relative path resolves correctly in
    // both. Every asset path in the catalogue is relative for the same reason.
    const res = await fetch('data/catalog.json');
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    cache = await res.json();
    cache.bySeller = new Map(cache.sellers.map(s => [s.id, s]));
    cache.byId = new Map(cache.products.map(p => [p.id, p]));
  }
  return cache;
}

async function rest(path, params = {}) {
  const url = new URL(`/rest/v1/${path}`, cfg().SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { apikey: cfg().SUPABASE_ANON_KEY, authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}` }
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

/* Rank, never filter, on interests.
 *
 * A buyer who taps only "Print" would get a nine-card deck from a filter and
 * would leave. Interest overlap is the strongest term, freshness next, and a
 * deterministic per-product jitter breaks ties so the deck is not the same
 * order for everyone. Nothing is ever excluded for taste — only for having
 * already been seen. */
function rank(products, { interests = [], seen = new Set() }) {
  const jitter = id => (([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0) % 1000) / 1000;
  const now = Date.now();
  return products
    .filter(p => p.status === 'live' && !seen.has(p.id))
    .map(p => {
      const match = interests.includes(p.interest) ? 1 : 0;
      const ageDays = (now - Date.parse(p.created_at)) / 86400000;
      const fresh = Math.max(0, 1 - ageDays / 90);
      return { p, score: match * 3 + fresh * 1.2 + jitter(p.id) * 0.8 };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);
}

const hydrate = (c, p) => ({ ...p, seller: c.bySeller.get(p.seller_id) });

export const api = {
  async meta() {
    const c = await catalog();
    return { interests: c.interests, cities: c.cities, sellers: c.sellers };
  },

  /* One page of the swipe deck. `seen` comes from the device, not the server —
     see store.js. */
  async deck({ limit = cfg().DECK_PAGE, offset = 0 } = {}) {
    const c = await catalog();
    const { interests, seen } = store.get();
    const ranked = rank(c.products, { interests, seen: new Set(seen) });
    return {
      items: ranked.slice(offset, offset + limit).map(p => hydrate(c, p)),
      remaining: Math.max(0, ranked.length - offset - limit)
    };
  },

  /* The home grid: newest first, optionally narrowed by interest — here a
     filter IS what the buyer asked for, because they tapped the chip. */
  async browse({ interest = null, limit = 60, offset = 0 } = {}) {
    const c = await catalog();
    const items = c.products
      .filter(p => p.status === 'live' && (!interest || p.interest === interest))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { items: items.slice(offset, offset + limit).map(p => hydrate(c, p)), total: items.length };
  },

  /* Standing in for Postgres full-text search. The live version is a tsvector
     + GIN index with pg_trgm for typos; deliberately NOT `ilike '%q%'`, which
     cannot use an index and degrades the moment the catalogue is real. */
  async search(q) {
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
    const c = await catalog();
    const p = c.byId.get(id);
    return p ? hydrate(c, p) : null;
  },

  async products(ids) {
    const c = await catalog();
    return ids.map(id => c.byId.get(id)).filter(Boolean).map(p => hydrate(c, p));
  },

  async sellers() { return (await catalog()).sellers; },

  /* Placing an order.
   *
   * Fixture mode keeps orders in localStorage so the confirmation and the
   * order-lookup screen are real and testable end to end. In live mode this
   * becomes a single Postgres RPC — one transaction that re-reads prices and
   * stock server-side, splits the bag into shipments and writes them, because
   * a price that came from the browser is a price an attacker chose. */
  async placeOrder(order) {
    if (live()) {
      const res = await fetch(new URL('/rest/v1/rpc/place_order', cfg().SUPABASE_URL), {
        method: 'POST',
        headers: {
          apikey: cfg().SUPABASE_ANON_KEY,
          authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(order)
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    const key = 'nova.orders.v1';
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[order.code] = order;
    localStorage.setItem(key, JSON.stringify(all));
    return order;
  },

  /* Reading an order back needs the phone as well as the code, matching
     get_order(code, phone) in 0003_place_order.sql: a guessed or
     shoulder-surfed code on its own must reveal nothing. Passing no phone is
     only for this device's own confirmation screen, straight after placing. */
  async order(code, phone = null) {
    if (live()) {
      const res = await fetch(new URL('/rest/v1/rpc/get_order', cfg().SUPABASE_URL), {
        method: 'POST',
        headers: {
          apikey: cfg().SUPABASE_ANON_KEY,
          authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ p_code: code, p_phone: phone })
      });
      if (!res.ok) return null;
      return (await res.json()) || null;
    }
    const all = JSON.parse(localStorage.getItem('nova.orders.v1') || '{}');
    const found = all[String(code || '').trim().toUpperCase()] || null;
    if (!found) return null;
    if (phone !== null && found.contact.phone !== phone) return null;
    return found;
  },

  /* Impressions and swipes are buffered and flushed in batches — one row per
     product per day server-side, never one row per view. A 500 MB free-tier
     database will not survive raw event logging, and the seller only ever sees
     the daily number anyway. */
  track: (() => {
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer; buffer = [];
      if (!live()) { console.debug('[track]', batch.length, 'events'); return; }
      navigator.sendBeacon?.(
        new URL('/rest/v1/rpc/record_events', cfg().SUPABASE_URL),
        new Blob([JSON.stringify({ events: batch })], { type: 'application/json' })
      );
    };
    setInterval(flush, 10000);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    return (type, product_id) => {
      buffer.push({ type, product_id, at: Date.now() });
      if (buffer.length >= 50) flush();
    };
  })()
};

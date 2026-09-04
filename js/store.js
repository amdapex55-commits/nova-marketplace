/* Everything the buyer has done, held on their own device.
 *
 * There is no buyer account in v1 — browsing, wishlisting and filling a bag all
 * happen before anyone is asked to identify themselves, and checkout takes a
 * name and phone as a guest. So this is the whole buyer-side database, and it
 * lives in localStorage.
 *
 * Why not IndexedDB: the largest thing here is the seen-ledger, capped below at
 * a few thousand ids (~40 KB). localStorage is synchronous, which means the
 * deck can filter seen products during its first paint instead of after an
 * await. If a buyer ever accumulates enough history to strain this, that is the
 * signal to add accounts, not to add IndexedDB.
 */

const KEY = 'nova.v1';

/* One bag line is one product-and-variant pair — Medium and Large are two
   lines, not one with a quantity of two, because they are two different things
   to pack. Everything that removes or re-counts a line addresses it by this,
   never by product id alone. */
export const bagKey = l => `${l.id}::${l.variant_id ?? ''}`;
const SEEN_CAP = 3000;

/* A random id for this browser. Not a person and not tracked across sites — it
   exists so a report can be rate-limited and duplicate reports collapsed, and
   so the deck can be told what this device has already seen. */
const newDeviceId = () =>
  [...crypto.getRandomValues(new Uint8Array(9))].map(b => b.toString(16).padStart(2, '0')).join('');

/* Product ids only mean anything to the backend that issued them. Fixture ids
   look like `p0021`; live ones are uuids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const backendNow = () => window.NOVAMKT?.BUYER_BACKEND || 'fixtures';

export const isLiveId = id => UUID.test(String(id || ''));

const blank = () => ({
  backend: backendNow(),
  device_id: newDeviceId(),
  gender: null,          // 'women' | 'men' | 'everything' | null (skipped)
  interests: [],         // ids from catalog.interests
  onboarded: false,
  seen: [],              // product ids already shown in the deck
  wishlist: [],          // product ids, most recent first
  bag: [],               // { id, qty }
  contact: null,         // remembered from the last checkout
  orders: []             // order codes placed on this device
});

function read() {
  let saved, storedBackend;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // Read the stored value BEFORE merging. blank() supplies a default for
    // `backend`, so comparing the merged object always matched and the purge
    // below never ran — state written before this field existed reads as
    // undefined, which is exactly the case that needs cleaning.
    storedBackend = parsed ? parsed.backend : backendNow();
    saved = parsed ? { ...blank(), ...parsed } : blank();
  } catch {
    // Private mode, blocked site data, corrupt JSON — never let storage break
    // the app. A buyer with no history is a working buyer.
    return blank();
  }

  /* The backend changed under this device.
     Anyone who used the app while it read fixtures has `p0021`-shaped ids in
     their seen-ledger, wishlist and bag. Sent to the live deck they are not
     uuids, Postgres rejects the whole call, and the deck never loads — which is
     exactly what happened on 4 Sep. Drop the ids that cannot belong to this
     backend and keep everything that still means something: the device id, the
     interests, the saved address, the order codes. */
  if (storedBackend !== backendNow()) {
    const keep = id => (backendNow() === 'live' ? UUID.test(id) : !UUID.test(id));
    saved.seen = (saved.seen || []).filter(keep);
    saved.wishlist = (saved.wishlist || []).filter(keep);
    saved.bag = (saved.bag || []).filter(l => keep(l.id));
    saved.backend = backendNow();
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* see above */ }
  }
  return saved;
}

let state = read();
const listeners = new Set();

function commit() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* see read() */ }
  for (const fn of listeners) fn(state);
}

export const store = {
  get: () => state,

  deviceId() {
    // Older saved state predates this field; mint one rather than sending null.
    if (!state.device_id) { state.device_id = newDeviceId(); commit(); }
    return state.device_id;
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  setOnboarding({ gender, interests }) {
    state.gender = gender;
    state.interests = interests;
    state.onboarded = true;
    commit();
  },

  /* --- seen ledger: without this, a returning buyer swipes the same products
     forever and the deck feels broken. Oldest ids fall off the front. --- */
  markSeen(ids) {
    const set = new Set(state.seen);
    for (const id of [].concat(ids)) set.add(id);
    state.seen = [...set].slice(-SEEN_CAP);
    commit();
  },
  unsee(id) { state.seen = state.seen.filter(x => x !== id); commit(); },
  hasSeen: id => state.seen.includes(id),
  resetSeen() { state.seen = []; commit(); },

  /* --- wishlist --- */
  toggleWish(id) {
    state.wishlist = state.wishlist.includes(id)
      ? state.wishlist.filter(x => x !== id)
      : [id, ...state.wishlist];
    commit();
    return state.wishlist.includes(id);
  },
  wished: id => state.wishlist.includes(id),

  /* --- bag: keyed on product AND variant, see bagKey above --- */
  addToBag(id, qty = 1, variant = null) {
    const v = variant?.variant_id ?? null;
    const line = state.bag.find(l => l.id === id && (l.variant_id ?? null) === v);
    if (line) line.qty = Math.min(10, line.qty + qty);
    else state.bag.push({ id, qty, variant_id: v, label: variant?.label ?? null });
    commit();
  },
  setQty(key, qty) {
    if (qty <= 0) state.bag = state.bag.filter(l => bagKey(l) !== key);
    else { const l = state.bag.find(x => bagKey(x) === key); if (l) l.qty = Math.min(10, qty); }
    commit();
  },
  removeFromBag(key) { state.bag = state.bag.filter(l => bagKey(l) !== key); commit(); },
  clearBag() { state.bag = []; commit(); },
  bagCount: () => state.bag.reduce((n, l) => n + l.qty, 0),
  inBag: id => state.bag.some(l => l.id === id),

  /* --- checkout memory: a returning buyer should not retype their address --- */
  rememberContact(contact) { state.contact = contact; commit(); },
  recordOrder(order) { state.orders = [order, ...state.orders].slice(0, 20); commit(); },

  reset() { state = blank(); commit(); }
};

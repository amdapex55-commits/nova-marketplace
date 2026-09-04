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
const SEEN_CAP = 3000;

/* A random id for this browser. Not a person and not tracked across sites — it
   exists so a report can be rate-limited and duplicate reports collapsed, and
   so the deck can be told what this device has already seen. */
const newDeviceId = () =>
  [...crypto.getRandomValues(new Uint8Array(9))].map(b => b.toString(16).padStart(2, '0')).join('');

const blank = () => ({
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
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    // Private mode, blocked site data, corrupt JSON — never let storage break
    // the app. A buyer with no history is a working buyer.
    return blank();
  }
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

  /* --- bag --- */
  addToBag(id, qty = 1) {
    const line = state.bag.find(l => l.id === id);
    if (line) line.qty = Math.min(10, line.qty + qty);
    else state.bag.push({ id, qty });
    commit();
  },
  setQty(id, qty) {
    if (qty <= 0) state.bag = state.bag.filter(l => l.id !== id);
    else { const l = state.bag.find(x => x.id === id); if (l) l.qty = Math.min(10, qty); }
    commit();
  },
  removeFromBag(id) { state.bag = state.bag.filter(l => l.id !== id); commit(); },
  clearBag() { state.bag = []; commit(); },
  bagCount: () => state.bag.reduce((n, l) => n + l.qty, 0),
  inBag: id => state.bag.some(l => l.id === id),

  /* --- checkout memory: a returning buyer should not retype their address --- */
  rememberContact(contact) { state.contact = contact; commit(); },
  recordOrder(order) { state.orders = [order, ...state.orders].slice(0, 20); commit(); },

  reset() { state = blank(); commit(); }
};

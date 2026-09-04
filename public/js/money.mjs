/* Order arithmetic. Pure functions, no DOM, no network — so the same code runs
 * in the browser and under `node --test`, and the numbers in the summary can
 * never drift from the numbers on the order.
 *
 * Nova Marketplace never touches the money. Each seller ships their own parcel
 * and collects on delivery; we charge sellers a subscription instead. That is
 * why an order is not one payment but a set of SHIPMENTS — one per seller —
 * each priced and settled independently. Getting this wrong is how a
 * marketplace ends up owing money it never held.
 */

export const RULES = {
  DELIVERY_SAME_CITY: 149,
  DELIVERY_OTHER_CITY: 249,
  EXPRESS_SURCHARGE: 120,
  // Per seller, not per order: a Rs 5,000 bag split across three sellers has
  // not earned free delivery from any of them.
  FREE_DELIVERY_OVER: 5000,
  // What a rider can be asked to carry back. Above this the order must be
  // prepaid, and checkout has to say so before the buyer fills the form.
  COD_LIMIT: 50000,
  MAX_QTY_PER_LINE: 10
};

export const formatPKR = n =>
  'Rs ' + Math.round(n).toLocaleString('en-PK');

/* One shipment = everything in the bag from a single seller. */
export function priceShipment({ lines, sellerCity, buyerCity, express = false }) {
  const items = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const sameCity = !!buyerCity && !!sellerCity &&
    sellerCity.trim().toLowerCase() === buyerCity.trim().toLowerCase();

  let delivery = sameCity ? RULES.DELIVERY_SAME_CITY : RULES.DELIVERY_OTHER_CITY;
  // Express is a real cost to the seller, so the free-delivery threshold waives
  // the standard fee only — it never waives the surcharge.
  const freeDelivery = items >= RULES.FREE_DELIVERY_OVER;
  if (freeDelivery) delivery = 0;
  if (express) delivery += RULES.EXPRESS_SURCHARGE;

  return {
    items,
    delivery,
    freeDelivery,
    sameCity,
    total: items + delivery,
    units: lines.reduce((sum, l) => sum + l.qty, 0)
  };
}

/* The whole bag, grouped into shipments in a stable order so the summary the
   buyer reviewed is the summary they are charged for. */
export function priceOrder({ lines, sellers, buyerCity, express = false }) {
  const bySeller = new Map();
  for (const line of lines) {
    if (!bySeller.has(line.seller_id)) bySeller.set(line.seller_id, []);
    bySeller.get(line.seller_id).push(line);
  }

  const shipments = [...bySeller.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seller_id, sellerLines]) => {
      const seller = sellers.find(s => s.id === seller_id);
      return {
        seller_id,
        seller: seller || { id: seller_id, brand_name: 'Unknown seller', city: '' },
        lines: sellerLines,
        ...priceShipment({ lines: sellerLines, sellerCity: seller?.city, buyerCity, express })
      };
    });

  const items = shipments.reduce((s, sh) => s + sh.items, 0);
  const delivery = shipments.reduce((s, sh) => s + sh.delivery, 0);
  const total = items + delivery;

  return {
    shipments,
    items,
    delivery,
    total,
    units: shipments.reduce((s, sh) => s + sh.units, 0),
    // Checked against the grand total, not per shipment: the rider limit is a
    // limit on the whole doorstep transaction the buyer is agreeing to.
    codAllowed: total <= RULES.COD_LIMIT
  };
}

/* ---------- Pakistani mobile numbers ---------- */

/* Accepts 03001234567, 0300-1234567, +923001234567, 923001234567, spaces and
   all. Returns the canonical 11-digit local form, or null. Sellers phone these
   numbers by hand, so a number that stores in three different shapes is a
   number that gets dialled wrong. */
export function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let local = digits;
  if (local.startsWith('0092')) local = local.slice(4);
  else if (local.startsWith('92')) local = local.slice(2);
  if (local.startsWith('0')) local = local.slice(1);
  if (!/^3\d{9}$/.test(local)) return null;
  return '0' + local;
}

export const prettyPhone = p => {
  const n = normalisePhone(p);
  return n ? `${n.slice(0, 4)} ${n.slice(4)}` : String(p || '');
};

/* Order codes are read aloud on the phone, so I is not used (reads as 1), and
   nor are O, 0 or 1. Six characters from a 32-symbol alphabet is ~1 in a
   billion — collision handling belongs on the server, not here. */
export function orderCode(random = Math.random) {
  const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += A[Math.floor(random() * A.length)];
  return 'NM-' + out;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder, priceShipment, normalisePhone, orderCode, RULES } from '../public/js/money.mjs';

const sellers = [
  { id: 's1', brand_name: 'Meher Studio', city: 'Lahore' },
  { id: 's2', brand_name: 'Sahil Sportswear', city: 'Karachi' }
];
const line = (id, seller_id, price, qty = 1) => ({ id, seller_id, price, qty });

test('same-city delivery is cheaper than cross-city', () => {
  const near = priceShipment({ lines: [line('a', 's1', 1000)], sellerCity: 'Lahore', buyerCity: 'lahore' });
  const far  = priceShipment({ lines: [line('a', 's1', 1000)], sellerCity: 'Lahore', buyerCity: 'Karachi' });
  assert.equal(near.delivery, RULES.DELIVERY_SAME_CITY);
  assert.equal(far.delivery, RULES.DELIVERY_OTHER_CITY);
  assert.equal(near.sameCity, true);
});

test('free delivery is earned per seller, never across the bag', () => {
  // Rs 6,000 total, but Rs 3,000 from each seller — neither has earned it.
  const o = priceOrder({
    lines: [line('a', 's1', 3000), line('b', 's2', 3000)],
    sellers, buyerCity: 'Multan'
  });
  assert.equal(o.shipments.length, 2);
  assert.ok(o.shipments.every(s => s.freeDelivery === false));
  assert.equal(o.delivery, RULES.DELIVERY_OTHER_CITY * 2);
  assert.equal(o.total, 6000 + RULES.DELIVERY_OTHER_CITY * 2);
});

test('crossing the threshold with one seller waives only that shipment', () => {
  const o = priceOrder({
    lines: [line('a', 's1', 6000), line('b', 's2', 900)],
    sellers, buyerCity: 'Lahore'
  });
  const [s1, s2] = o.shipments;
  assert.equal(s1.delivery, 0);
  assert.equal(s1.freeDelivery, true);
  assert.equal(s2.delivery, RULES.DELIVERY_OTHER_CITY);
});

test('express surcharge survives free delivery', () => {
  const s = priceShipment({ lines: [line('a', 's1', 9000)], sellerCity: 'Lahore', buyerCity: 'Lahore', express: true });
  assert.equal(s.freeDelivery, true);
  assert.equal(s.delivery, RULES.EXPRESS_SURCHARGE);
});

test('the totals in the summary equal the sum of the shipments', () => {
  const o = priceOrder({
    lines: [line('a', 's1', 1200, 3), line('b', 's1', 450), line('c', 's2', 2500, 2)],
    sellers, buyerCity: 'Islamabad', express: true
  });
  assert.equal(o.items, o.shipments.reduce((n, s) => n + s.items, 0));
  assert.equal(o.total, o.shipments.reduce((n, s) => n + s.total, 0));
  assert.equal(o.units, 6);
});

test('COD is refused above the rider limit', () => {
  const under = priceOrder({ lines: [line('a', 's1', 40000)], sellers, buyerCity: 'Lahore' });
  const over  = priceOrder({ lines: [line('a', 's1', 60000)], sellers, buyerCity: 'Lahore' });
  assert.equal(under.codAllowed, true);
  assert.equal(over.codAllowed, false);
});

test('shipment order is stable regardless of how the bag was filled', () => {
  const a = priceOrder({ lines: [line('x', 's2', 100), line('y', 's1', 100)], sellers, buyerCity: 'Lahore' });
  const b = priceOrder({ lines: [line('y', 's1', 100), line('x', 's2', 100)], sellers, buyerCity: 'Lahore' });
  assert.deepEqual(a.shipments.map(s => s.seller_id), b.shipments.map(s => s.seller_id));
});

test('phone numbers normalise to one dialable shape', () => {
  for (const input of ['03001234567', '0300-1234567', '+92 300 1234567', '923001234567', '00923001234567', '0300 123 4567'])
    assert.equal(normalisePhone(input), '03001234567', `failed on ${input}`);
  for (const bad of ['', '0300123456', '02112345678', 'abcd', '3001234567890'])
    assert.equal(normalisePhone(bad), null, `should reject ${bad}`);
});

test('order codes avoid characters that are misheard on a phone call', () => {
  const code = orderCode(() => 0.999999);
  assert.match(code, /^NM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.ok(!/[OI10]/.test(code.slice(3)));
});

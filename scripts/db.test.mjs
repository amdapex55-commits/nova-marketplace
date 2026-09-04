/* Database tests — schema, RLS and place_order, against a real Postgres.
 *
 *   npm run test:db
 *
 * supabase/local/bootstrap.sql runs FIRST and deliberately hands anon and
 * authenticated everything Supabase would, defaults included. If 20260903230002_rls.sql
 * fails to take it back, these tests fail — which is the point. A local harness
 * that is stricter than production is how NovaCars shipped a grant that did
 * nothing and passed twelve assertions doing it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RULES, priceOrder } from '../public/js/money.mjs';

const run = promisify(execFile);
const DB = process.env.NOVA_DB || 'nova_marketplace_dev';
const ROOT = path.resolve(import.meta.dirname, '..');
const SEP = '~|~';

/* Every query runs as a real role — anon, authenticated, or the owner — so RLS
   and the grants are genuinely in the path rather than simulated. */
async function sql(text, { role = null, uid = null, email = null } = {}) {
  const prelude = [
    role ? `set local role ${role};` : '',
    uid !== null ? `set local request.jwt.uid = '${uid}';` : '',
    // is_admin() reads the email out of auth.jwt(), so an admin is impersonated
    // by presenting a claim set — the same thing GoTrue signs in production.
    email !== null ? `set local request.jwt.claims = '${JSON.stringify({ email })}';` : ''
  ].join(' ');
  const wrapped = `begin; ${prelude} ${text} ; commit;`;
  const { stdout } = await run('psql', ['-qtA', '-F', SEP, '-v', 'ON_ERROR_STOP=1', '-c', wrapped, DB]);
  return stdout.trim().split('\n').filter(Boolean).map(r => r.split(SEP));
}

const fails = async (text, opts) => {
  try { await sql(text, opts); return null; }
  catch (e) { return String(e.stderr || e.message); }
};

let sellerA, sellerB, userA, userB, prodA1, prodA2, prodB1, dear;

before(async () => {
  // Create the database here rather than expecting one to exist. The after()
  // hook drops it, so a suite that assumed it was already there passed the
  // first time and failed every run after — which reads exactly like the
  // migrations broke.
  await run('psql', ['-q', '-c', `drop database if exists ${DB} with (force)`, 'postgres']);
  await run('psql', ['-q', '-c', `create database ${DB}`, 'postgres']);

  // Read the migrations off disk in filename order rather than listing them
  // here: a hardcoded list silently skips whatever was added last, and every
  // test for it fails in a way that looks like the migration is broken.
  await run('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'supabase/local/bootstrap.sql'), DB]);
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const f of (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await run('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(dir, f), DB]);
  }

  const rows = await sql(`
    with sa as (insert into sellers (brand_name, city, status) values ('Meher Studio','Lahore','active') returning id),
         sb as (insert into sellers (brand_name, city, status) values ('Chai Patti','Karachi','active') returning id),
         ca as (insert into seller_contacts (seller_id, user_id, owner_name, phone, address)
                select id, gen_random_uuid(), 'A Owner', '03001112222', 'Lahore addr' from sa returning seller_id, user_id),
         cb as (insert into seller_contacts (seller_id, user_id, owner_name, phone, address)
                select id, gen_random_uuid(), 'B Owner', '03003334444', 'Karachi addr' from sb returning seller_id, user_id),
         -- Deep stock on purpose: this is the workhorse row that most tests buy
         -- from, and a fixture that sells out mid-run fails the later tests for
         -- a reason that has nothing to do with what they are checking. The
         -- scarce row below is the one the stock test needs.
         p1 as (insert into products (seller_id, title, price, interest, city, stock, status)
                select id, 'Ajrak Kurta', 3000, 'clothing', 'Lahore', 500, 'live' from sa returning id),
         p2 as (insert into products (seller_id, title, price, interest, city, stock, status)
                select id, 'Linen Shirt', 2500, 'clothing', 'Lahore', 2, 'live' from sa returning id),
         p3 as (insert into products (seller_id, title, price, interest, city, stock, status)
                select id, 'Acacia Honey', 1800, 'food', 'Karachi', 500, 'live' from sb returning id),
         p4 as (insert into products (seller_id, title, price, interest, city, stock, status)
                select id, 'Gold Bangle', 60000, 'clothing', 'Lahore', 50, 'live' from sa returning id),
         hidden as (insert into products (seller_id, title, price, interest, city, status)
                select id, 'Draft Item', 999, 'clothing', 'Lahore', 'pending' from sa returning id)
    select (select id from sa), (select id from sb), (select user_id from ca), (select user_id from cb),
           (select id from p1), (select id from p2), (select id from p3), (select id from p4);`);
  [sellerA, sellerB, userA, userB, prodA1, prodA2, prodB1, dear] = rows[0];
});

after(async () => {
  await run('psql', ['-q', '-c', `drop database if exists ${DB} with (force)`, 'postgres']);
});

/* ---------------------------------------------------- grants and exposure -- */

test('anon cannot reach orders at all, even with Supabase-style defaults granted first', async () => {
  const err = await fails('select count(*) from orders;', { role: 'anon' });
  assert.ok(err, 'anon must not be able to select from orders');
  assert.match(err, /permission denied/i);
});

test('anon cannot read seller phone numbers or addresses', async () => {
  const err = await fails('select phone from seller_contacts;', { role: 'anon' });
  assert.ok(err, 'seller_contacts must be unreachable for anon');
  assert.match(err, /permission denied/i);
});

test('anon sees live products and nothing else', async () => {
  const titles = (await sql('select title from products order by title;', { role: 'anon' })).map(r => r[0]);
  assert.ok(titles.includes('Ajrak Kurta'));
  assert.ok(!titles.includes('Draft Item'), 'a pending listing must not be public');
});

test('anon cannot write anything', async () => {
  assert.ok(await fails(`update products set price = 1 where id = '${prodA1}';`, { role: 'anon' }));
  assert.ok(await fails(
    `insert into products (seller_id, title, price, interest, city) values ('${sellerA}','x',1,'y','z');`,
    { role: 'anon' }));
});

/* ------------------------------------------------------------ cross-scope -- */

test('a seller cannot see another seller\'s unlisted products', async () => {
  const titles = (await sql('select title from products order by title;', { role: 'authenticated', uid: userA })).map(r => r[0]);
  assert.ok(titles.includes('Draft Item'), 'seller A should see their own pending listing');
  // Seller B's live products ARE visible to A — through the public policy, the
  // same way any shopper sees them. What must never leak is B's non-live rows.
  const hidden = await sql(
    `select count(*) from products where seller_id = '${sellerB}' and status <> 'live';`,
    { role: 'authenticated', uid: userA });
  assert.equal(hidden[0][0], '0');
});

test('a seller cannot edit another seller\'s product', async () => {
  await sql(`update products set price = 3100 where id = '${prodA1}';`, { role: 'authenticated', uid: userA });
  assert.equal((await sql(`select price from products where id = '${prodA1}';`))[0][0], '3100',
    'seller A must be able to edit their own');

  await sql(`update products set price = 1 where id = '${prodB1}';`, { role: 'authenticated', uid: userA });
  assert.equal((await sql(`select price from products where id = '${prodB1}';`))[0][0], '1800',
    "seller A's update must not touch seller B's row");
});

/* ------------------------------------------------------------ place_order -- */

const order = (lines, contact = {}, extra = {}) => JSON.stringify({
  contact: {
    name: 'Aisha', phone: '03001234567', city: 'Lahore',
    area: 'Gulberg', address: 'House 42, Street 7', ...contact
  },
  lines, ...extra
});

test('place_order prices from the database, not from the browser', async () => {
  // The client sends no price at all — and a hostile client that sends one
  // cannot change the total, because place_order never reads it.
  const payload = order([{ product_id: prodA1, qty: 2, price: 1 }]);
  const [[out]] = await sql(`select place_order('${payload}'::jsonb)::text;`, { role: 'anon' });
  const o = JSON.parse(out);
  assert.equal(o.totals.items, 6200, '2 x Rs 3,100 read from the row');
  assert.equal(o.shipments.length, 1);
  assert.equal(o.shipments[0].collected_by, 'seller');
  assert.match(o.code, /^NM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
});

test('stock is decremented, and an oversell is refused', async () => {
  assert.equal((await sql(`select stock from products where id = '${prodA2}';`))[0][0], '2');

  const err = await fails(`select place_order('${order([{ product_id: prodA2, qty: 5 }])}'::jsonb);`, { role: 'anon' });
  assert.match(err, /not enough stock/);
  assert.equal((await sql(`select stock from products where id = '${prodA2}';`))[0][0], '2',
    'a refused order must not move stock');

  await sql(`select place_order('${order([{ product_id: prodA2, qty: 2 }])}'::jsonb);`, { role: 'anon' });
  const [[stock, status]] = await sql(`select stock, status from products where id = '${prodA2}';`);
  assert.equal(stock, '0');
  assert.equal(status, 'sold', 'a product that runs out should leave the deck');
});

test('a bag from two sellers becomes two shipments, each with its own delivery', async () => {
  const payload = order([{ product_id: prodA1, qty: 1 }, { product_id: prodB1, qty: 1 }]);
  const [[out]] = await sql(`select place_order('${payload}'::jsonb)::text;`, { role: 'anon' });
  const o = JSON.parse(out);
  assert.equal(o.shipments.length, 2);
  assert.equal(o.shipments.find(s => s.from === 'Lahore').delivery, RULES.DELIVERY_SAME_CITY);
  assert.equal(o.shipments.find(s => s.from === 'Karachi').delivery, RULES.DELIVERY_OTHER_CITY);
  assert.equal(o.totals.total, o.shipments.reduce((n, s) => n + s.total, 0));
});

test('the database and money.mjs agree on every price', async () => {
  // Two implementations exist because one has to run before the buyer commits
  // and the other has to be the authority. They must never disagree.
  const cases = [
    { lines: [{ product_id: prodA1, qty: 1 }], city: 'Lahore', express: false },
    { lines: [{ product_id: prodA1, qty: 1 }], city: 'Karachi', express: false },
    { lines: [{ product_id: prodA1, qty: 2 }], city: 'Lahore', express: true },
    { lines: [{ product_id: prodA1, qty: 1 }, { product_id: prodB1, qty: 2 }], city: 'Multan', express: false },
    { lines: [{ product_id: prodA1, qty: 1 }, { product_id: prodB1, qty: 2 }], city: 'Karachi', express: true }
  ];
  const sellers = [{ id: sellerA, brand_name: 'Meher Studio', city: 'Lahore' },
                   { id: sellerB, brand_name: 'Chai Patti', city: 'Karachi' }];
  const price = { [prodA1]: 3100, [prodB1]: 1800 };
  const sellerOf = { [prodA1]: sellerA, [prodB1]: sellerB };

  for (const c of cases) {
    const payload = order(c.lines, { city: c.city }, { express: c.express });
    const [[out]] = await sql(`select place_order('${payload}'::jsonb)::text;`, { role: 'anon' });
    const fromDb = JSON.parse(out).totals;
    const fromJs = priceOrder({
      lines: c.lines.map(l => ({
        id: l.product_id, seller_id: sellerOf[l.product_id], price: price[l.product_id], qty: l.qty
      })),
      sellers, buyerCity: c.city, express: c.express
    });
    const label = `${c.city}${c.express ? ' express' : ''} x${c.lines.length}`;
    assert.equal(fromDb.items, fromJs.items, `items disagree: ${label}`);
    assert.equal(fromDb.delivery, fromJs.delivery, `delivery disagrees: ${label}`);
    assert.equal(fromDb.total, fromJs.total, `total disagrees: ${label}`);
  }
});

test('cash on delivery is refused above the rider limit', async () => {
  const err = await fails(
    `select place_order('${order([{ product_id: dear, qty: 1 }], {}, { payment: 'cod' })}'::jsonb);`,
    { role: 'anon' });
  assert.match(err, /cash on delivery is not available/);

  const [[out]] = await sql(
    `select place_order('${order([{ product_id: dear, qty: 1 }], {}, { payment: 'transfer' })}'::jsonb)::text;`,
    { role: 'anon' });
  assert.equal(JSON.parse(out).payment, 'transfer');
});

test('a pending listing cannot be bought', async () => {
  const [[hidden]] = await sql(`select id from products where title = 'Draft Item';`);
  const err = await fails(`select place_order('${order([{ product_id: hidden, qty: 1 }])}'::jsonb);`, { role: 'anon' });
  assert.match(err, /no longer available/);
});

/* -------------------------------------------------------------- get_order -- */

test('an order code alone does not open the order', async () => {
  const [[out]] = await sql(`select place_order('${order([{ product_id: prodA1, qty: 1 }])}'::jsonb)::text;`, { role: 'anon' });
  const code = JSON.parse(out).code;

  const [[wrong]] = await sql(`select coalesce(get_order('${code}', '03009999999')::text, 'null');`, { role: 'anon' });
  assert.equal(wrong, 'null', 'the wrong phone must return nothing');

  const [[right]] = await sql(`select get_order('${code}', '03001234567')::text;`, { role: 'anon' });
  assert.equal(JSON.parse(right).code, code);
});

test('a seller sees only their own shipments', async () => {
  const a = Number((await sql('select count(*) from shipments;', { role: 'authenticated', uid: userA }))[0][0]);
  const b = Number((await sql('select count(*) from shipments;', { role: 'authenticated', uid: userB }))[0][0]);
  const all = Number((await sql('select count(*) from shipments;'))[0][0]);
  assert.ok(a > 0 && b > 0, 'both sellers should have shipments by now');
  assert.equal(a + b, all, 'the two sellers between them should see every shipment exactly once');
});

test('a seller cannot write to shipments directly at all', async () => {
  // This used to assert that the row-level policy let a seller mark their own
  // parcel dispatched while blocking a reassignment. 0004 removed that grant
  // outright, because RLS restricts rows and never columns — the same grant
  // that allowed `status` also allowed `total`. Advancing a parcel now goes
  // through set_shipment_status(), which is tested below.
  const [[id]] = await sql(`select s.id from shipments s where s.seller_id = '${sellerA}' limit 1;`);
  assert.ok(await fails(`update shipments set status = 'dispatched' where id = '${id}';`,
                        { role: 'authenticated', uid: userA }));
  assert.ok(await fails(`update shipments set seller_id = '${sellerB}' where id = '${id}';`,
                        { role: 'authenticated', uid: userA }));
});

/* ------------------------------------------------- seller workspace (0004) -- */

/* A signed-in user with no shop yet — register_seller() has to work for them,
   which means auth.uid() exists but my_seller_id() is still null. */
const NEW_USER = '11111111-2222-3333-4444-555555555555';

test('a seller can create their own shop, and lands on pending', async () => {
  const [[out]] = await sql(
    `select register_seller('Rawal Leather','B Owner','03007778888','Shop 4, Anarkali','Lahore')::text;`,
    { role: 'authenticated', uid: NEW_USER });
  const me = JSON.parse(out);
  assert.equal(me.brand_name, 'Rawal Leather');
  assert.equal(me.status, 'pending', 'approval is per seller, once — not per listing');
  assert.equal(me.products, 0);
});

test('a pending seller can still read their own shop', async () => {
  // Before 0004 the only select policy was `status = 'active'`, so a pending
  // seller opened the workspace to nothing and no explanation.
  const [[out]] = await sql(`select me()::text;`, { role: 'authenticated', uid: NEW_USER });
  assert.equal(JSON.parse(out).status, 'pending');
});

test('one account cannot own two shops', async () => {
  const err = await fails(
    `select register_seller('Second Shop','B','03007778888','x','Lahore');`,
    { role: 'authenticated', uid: NEW_USER });
  assert.match(err, /already has a shop/);
});

test('a seller cannot promote themselves to active', async () => {
  // There is no UPDATE grant on sellers at all, so status is out of reach —
  // and update_shopfront() deliberately does not accept it.
  const err = await fails(`update sellers set status = 'active' where id = my_seller_id();`,
                          { role: 'authenticated', uid: NEW_USER });
  assert.ok(err, 'a seller must not be able to approve themselves');
  const [[out]] = await sql(`select me()::text;`, { role: 'authenticated', uid: NEW_USER });
  assert.equal(JSON.parse(out).status, 'pending');
});

test('publishing needs a photo, stock, and an approved seller', async () => {
  const [[pid]] = await sql(
    `insert into products (seller_id, title, price, interest, city, stock, status)
     select id, 'Leather Belt', 2200, 'clothing', 'Lahore', 3, 'draft' from sellers where brand_name = 'Rawal Leather'
     returning id;`);

  const noPhoto = await fails(`select publish_product('${pid}', true);`, { role: 'authenticated', uid: NEW_USER });
  assert.match(noPhoto, /at least one photo/);

  await sql(`insert into photos (product_id, position, key) values ('${pid}', 0, 'x/y-card.webp');`);

  // Seller still pending, so the listing waits with them rather than going live.
  const [[pending]] = await sql(`select publish_product('${pid}', true);`, { role: 'authenticated', uid: NEW_USER });
  assert.equal(pending, 'pending');

  await sql(`update sellers set status = 'active' where brand_name = 'Rawal Leather';`);
  const [[live]] = await sql(`select publish_product('${pid}', true);`, { role: 'authenticated', uid: NEW_USER });
  assert.equal(live, 'live', 'once the seller is approved their listings go straight up');

  const [[zero]] = await sql(`select publish_product('${pid}', false);`, { role: 'authenticated', uid: NEW_USER });
  assert.equal(zero, 'draft');
});

test('a seller cannot publish, or unpublish, somebody else\'s listing', async () => {
  const err = await fails(`select publish_product('${prodA1}', true);`, { role: 'authenticated', uid: NEW_USER });
  assert.match(err, /not your listing/);
});

test('THE MONEY HOLE: a seller cannot rewrite the totals on their own shipment', async () => {
  // 0002 granted `update on shipments` so a parcel could be marked dispatched.
  // RLS restricts rows, never columns — so that same grant let a seller edit
  // items_total, delivery and total AFTER the buyer had agreed to them.
  // 0004 revokes it. If this test ever passes an update, the hole is back.
  const [[id, before]] = await sql(
    `select id, total from shipments where seller_id = '${sellerA}' limit 1;`);

  const err = await fails(`update shipments set total = 999999 where id = '${id}';`,
                          { role: 'authenticated', uid: userA });
  assert.ok(err, 'a seller must not be able to write to shipments directly');
  assert.match(err, /permission denied/i);

  const [[after]] = await sql(`select total from shipments where id = '${id}';`);
  assert.equal(after, before, 'the agreed total must be exactly what the buyer saw');
});

test('a seller advances their own parcel, forward only', async () => {
  const [[id]] = await sql(`select id from shipments where seller_id = '${sellerA}' and status = 'placed' limit 1;`);
  const [[s1]] = await sql(`select set_shipment_status('${id}', 'dispatched');`, { role: 'authenticated', uid: userA });
  assert.equal(s1, 'dispatched');

  await sql(`select set_shipment_status('${id}', 'delivered');`, { role: 'authenticated', uid: userA });
  const closed = await fails(`select set_shipment_status('${id}', 'dispatched');`, { role: 'authenticated', uid: userA });
  assert.match(closed, /already closed/, 'a delivered parcel cannot be walked backwards');

  const bogus = await fails(`select set_shipment_status('${id}', 'placed');`, { role: 'authenticated', uid: userA });
  assert.match(bogus, /not a status a seller can set/);
});

test('a seller cannot touch another seller\'s parcel', async () => {
  const [[id]] = await sql(`select id from shipments where seller_id = '${sellerB}' limit 1;`);
  const err = await fails(`select set_shipment_status('${id}', 'dispatched');`, { role: 'authenticated', uid: userA });
  assert.match(err, /not your parcel/);
});

test('the order inbox shows the buyer\'s address — and only for own parcels', async () => {
  // `orders` has no grant for authenticated and must never get one, or every
  // seller reads every buyer. my_shipments() is the only way through.
  assert.ok(await fails('select buyer_phone from orders;', { role: 'authenticated', uid: userA }),
    'orders must stay unreachable even for a signed-in seller');

  const [[out]] = await sql(`select my_shipments()::text;`, { role: 'authenticated', uid: userA });
  const mine = JSON.parse(out);
  assert.ok(mine.length > 0);
  assert.ok(mine[0].buyer.phone && mine[0].buyer.address, 'a seller must be able to deliver');
  assert.ok(mine[0].lines.length > 0);

  const [[bOut]] = await sql(`select my_shipments()::text;`, { role: 'authenticated', uid: userB });
  const theirs = JSON.parse(bOut);
  const overlap = mine.filter(m => theirs.some(t => t.id === m.id));
  assert.equal(overlap.length, 0, 'two sellers must never see the same parcel');
});

test('deleting a listing hands back its photo keys, because Storage has no cascade', async () => {
  const [[pid]] = await sql(
    `insert into products (seller_id, title, price, interest, city, stock, status)
     select id, 'Throwaway', 500, 'clothing', 'Lahore', 1, 'draft' from sellers where brand_name = 'Rawal Leather'
     returning id;`);
  await sql(`insert into photos (product_id, position, key) values ('${pid}', 0, 'a/one.webp'), ('${pid}', 1, 'a/two.webp');`);

  const [[out]] = await sql(`select delete_product('${pid}')::text;`, { role: 'authenticated', uid: NEW_USER });
  const keys = JSON.parse(out);
  assert.deepEqual(keys.sort(), ['a/one.webp', 'a/two.webp'],
    'the caller needs these to clear the objects itself — deleting the row will not');
  assert.equal((await sql(`select count(*) from products where id = '${pid}';`))[0][0], '0');
});

test('a listing that has been ordered cannot be deleted', async () => {
  const [[pid]] = await sql(`select product_id from shipment_lines limit 1;`);
  const [[owner]] = await sql(`select user_id from seller_contacts c
    join products p on p.seller_id = c.seller_id where p.id = '${pid}';`);
  const err = await fails(`select delete_product('${pid}');`, { role: 'authenticated', uid: owner });
  assert.match(err, /has been ordered/, 'an order must keep referring to something');
});

/* -------------------------------------------------------- storage policies -- */

test('a seller can only write photos into their own folder', async () => {
  const [[mine]] = await sql(`select my_seller_id();`, { role: 'authenticated', uid: userA });
  const [[theirs]] = await sql(`select my_seller_id();`, { role: 'authenticated', uid: userB });

  const ok = await fails(
    `insert into storage.objects (bucket_id, name) values ('product-photos', '${mine}/p1/abc-card.webp');`,
    { role: 'authenticated', uid: userA });
  assert.equal(ok, null, 'a seller must be able to write into their own folder');

  const hijack = await fails(
    `insert into storage.objects (bucket_id, name) values ('product-photos', '${theirs}/p1/evil-card.webp');`,
    { role: 'authenticated', uid: userA });
  assert.ok(hijack, "writing into another seller's folder must be refused");
  assert.match(hijack, /row-level security/i);
});

test('a seller cannot delete another seller\'s photos', async () => {
  const [[theirs]] = await sql(`select my_seller_id();`, { role: 'authenticated', uid: userB });
  await sql(`insert into storage.objects (bucket_id, name) values ('product-photos', '${theirs}/p9/keep-card.webp');`);

  // The live Storage API answers a refused delete with 200 and an empty list,
  // not an error — so the only honest check is whether the row survived.
  await sql(`delete from storage.objects where name = '${theirs}/p9/keep-card.webp';`,
            { role: 'authenticated', uid: userA });
  const [[left]] = await sql(`select count(*) from storage.objects where name = '${theirs}/p9/keep-card.webp';`);
  assert.equal(left, '1', "another seller's file must still be there");
});

test('product photos are readable by anyone — it is a shopfront', async () => {
  const rows = await sql(`select count(*) from storage.objects where bucket_id = 'product-photos';`, { role: 'anon' });
  assert.ok(Number(rows[0][0]) > 0);
});

/* --------------------------------------------------------------- admin (0005) */

const ADMIN = 'boss@nova.test';
const ADMIN_UID = '99999999-8888-7777-6666-555555555555';

test('an admin is nobody until they are in the table', async () => {
  const [[before]] = await sql('select is_admin();', { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(before, 'f');
  await sql(`insert into admins (email) values ('${ADMIN}');`);
  const [[after]] = await sql('select is_admin();', { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(after, 't');
});

test('the admins table is unreachable through the API by anyone', async () => {
  // No grant at all, for anon or authenticated. is_admin() reads it as definer.
  assert.match(await fails('select * from admins;', { role: 'anon' }), /permission denied/i);
  assert.match(await fails('select * from admins;', { role: 'authenticated', uid: userA }), /permission denied/i);
  assert.match(await fails(`insert into admins (email) values ('me@evil.test');`,
                           { role: 'authenticated', uid: userA }), /permission denied/i);
});

test('a signed-in seller cannot reach a single admin function', async () => {
  // The seller UI never mentions these, but that is cosmetic — what actually
  // stops a seller is that every one of them refuses a caller who is not in
  // `admins`, whatever screen the request came from.
  for (const call of [
    'admin_overview()',
    'admin_sellers(null)',
    `admin_set_seller_status('${sellerB}', 'active')`,
    `admin_set_seller_plan('${sellerB}', 'monthly', 1)`,
    'admin_listings(null)',
    `admin_set_product_status('${prodA1}', 'removed')`,
    `admin_set_promoted('${prodA1}', true)`,
    'admin_orders(10)'
  ]) {
    const err = await fails(`select ${call};`, { role: 'authenticated', uid: userA, email: 'seller@nova.test' });
    assert.match(err, /not permitted/, `${call} let a seller through`);
  }
});

test('an anonymous visitor cannot reach them either', async () => {
  const err = await fails('select admin_overview();', { role: 'anon' });
  assert.ok(err, 'anon must not get an overview');
});

test('a seller cannot promote their own listing', async () => {
  // Promotion is something we sell, not something a seller helps themselves to.
  assert.ok(await fails(`update products set promoted = true where id = '${prodA1}';`,
                        { role: 'authenticated', uid: userA }) ||
            (await sql(`select promoted from products where id = '${prodA1}';`))[0][0] === 'f',
    'a seller must not be able to set promoted');
  const [[promoted]] = await sql(`select promoted from products where id = '${prodA1}';`);
  assert.equal(promoted, 'f');
});

test('approving a shop releases the listings queued behind it', async () => {
  const [[sid]] = await sql(
    `insert into sellers (brand_name, city, status) values ('Queued Shop','Multan','pending') returning id;`);
  const [[pid]] = await sql(
    `insert into products (seller_id, title, price, interest, city, stock, status)
     values ('${sid}', 'Waiting Item', 1500, 'clothing', 'Multan', 2, 'pending') returning id;`);
  await sql(`insert into photos (product_id, position, key) values ('${pid}', 0, 'q/w');`);
  // A queued listing with no photo must NOT be released — it would reach the
  // deck as a blank card.
  const [[blank]] = await sql(
    `insert into products (seller_id, title, price, interest, city, stock, status)
     values ('${sid}', 'No Photo', 900, 'clothing', 'Multan', 1, 'pending') returning id;`);

  const [[out]] = await sql(`select admin_set_seller_status('${sid}', 'active')::text;`,
                            { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(JSON.parse(out).status, 'active');
  assert.equal((await sql(`select status from products where id = '${pid}';`))[0][0], 'live');
  assert.equal((await sql(`select status from products where id = '${blank}';`))[0][0], 'pending',
    'a listing with no photograph must stay behind');
});

test('suspending a shop pulls its listings out of the deck in the same motion', async () => {
  const [[sid]] = await sql(`select id from sellers where brand_name = 'Queued Shop';`);
  await sql(`select admin_set_seller_status('${sid}', 'suspended');`,
            { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  const live = await sql(`select count(*) from products where seller_id = '${sid}' and status = 'live';`);
  assert.equal(live[0][0], '0', 'a shop that is off must not still be selling');
});

test('marking a payment extends from whichever date is later', async () => {
  const [[sid]] = await sql(`select id from sellers where brand_name = 'Queued Shop';`);
  // Trial still has time left: a payment must add to it, not replace it.
  await sql(`update sellers set trial_ends_at = now() + interval '20 days', plan = 'trial' where id = '${sid}';`);
  const [[out]] = await sql(`select admin_set_seller_plan('${sid}', 'monthly', 1)::text;`,
                            { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  const paidUntil = new Date(JSON.parse(out).paid_until);
  const days = (paidUntil - Date.now()) / 86400000;
  assert.ok(days > 45 && days < 55, `expected roughly 50 days, got ${days.toFixed(1)} — a payment must not shorten what they had`);
});

test('an admin can take a listing down, and promote one', async () => {
  const [[status]] = await sql(`select admin_set_product_status('${prodA1}', 'removed');`,
                               { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(status, 'removed');
  const titles = (await sql('select title from products;', { role: 'anon' })).map(r => r[0]);
  assert.ok(!titles.includes('Ajrak Kurta'), 'a removed listing must leave the storefront');

  await sql(`select admin_set_product_status('${prodA1}', 'live');`, { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  const [[promoted]] = await sql(`select admin_set_promoted('${prodA1}', true);`,
                                 { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(promoted, 't');
});

test('the overview counts what it says it counts', async () => {
  const [[out]] = await sql('select admin_overview()::text;', { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  const o = JSON.parse(out);
  const [[orders]] = await sql('select count(*) from orders;');
  const [[gmv]] = await sql('select coalesce(sum(grand_total),0) from orders;');
  assert.equal(o.orders_total, Number(orders));
  assert.equal(o.gmv_total, Number(gmv));
  assert.ok(o.sellers_active >= 1);
});

test('a seller cannot publish by writing status directly, bypassing the checks', async () => {
  // publish_product() refuses a listing with no photo, no stock, or an
  // unapproved shop. None of that is worth anything if a seller can simply
  // PATCH status='live' — RLS restricts which ROWS they may write, never which
  // COLUMNS. Same class as the shipments money hole in 0004.
  const [[sid]] = await sql(`select id from sellers where brand_name = 'Rawal Leather';`);
  const [[uid]] = await sql(`select user_id from seller_contacts where seller_id = '${sid}';`);
  const [[pid]] = await sql(
    `insert into products (seller_id, title, price, interest, city, stock, status)
     values ('${sid}', 'Sneaky Item', 100, 'clothing', 'Lahore', 0, 'draft') returning id;`);

  await sql(`update products set status = 'live' where id = '${pid}';`, { role: 'authenticated', uid });
  const [[status]] = await sql(`select status from products where id = '${pid}';`);
  assert.equal(status, 'draft',
    'a listing with no photo and no stock must not be able to make itself live');
});

/* --------------------------------------------- buyer reads, reports, stats -- */

async function makeLiveCatalogue() {
  // A second active seller with live stock, so ranking and search have
  // something to rank and search.
  const [[sid]] = await sql(
    `insert into sellers (brand_name, city, status) values ('Deck Shop','Karachi','active') returning id;`);
  await sql(`insert into seller_contacts (seller_id, user_id, owner_name, phone, address)
             values ('${sid}', gen_random_uuid(), 'D', '03005556666', 'x');`);
  for (const [title, interest, price] of [
    ['Chikankari Kurta', 'clothing', 3400],
    ['Handblock Lawn Suit', 'clothing', 5200],
    ['Kashmiri Chai Blend', 'food', 1200],
    ['Riso Print Quarterly', 'magazines', 900]
  ]) {
    const [[pid]] = await sql(
      `insert into products (seller_id, title, price, interest, city, stock, status, tags)
       values ('${sid}', '${title}', ${price}, '${interest}', 'Karachi', 5, 'live', array['${interest}'])
       returning id;`);
    await sql(`insert into photos (product_id, position, key) values ('${pid}', 0, 'k/${pid}');`);
  }
  return sid;
}

test('the deck ranks on interest and promotion, and never returns a seen card', async () => {
  await makeLiveCatalogue();
  // An earlier test promotes a listing, and promotion is a ranking term — so
  // clear it here or this test is asserting the wrong thing intermittently.
  await sql(`update products set promoted = false;`);
  const [[out]] = await sql(`select deck(array['food']::text[], '{}'::uuid[], 10, 0)::text;`, { role: 'anon' });
  const page = JSON.parse(out);
  assert.ok(page.items.length > 0);
  assert.equal(page.items[0].interest, 'food', 'the tapped interest should come first');
  assert.ok(page.items[0].photo_keys.length > 0, 'cards need a photo to be worth swiping');
  assert.ok(page.items[0].seller.brand_name, 'and a shop name');

  const first = page.items[0].id;
  const [[next]] = await sql(`select deck(array['food']::text[], array['${first}']::uuid[], 10, 0)::text;`, { role: 'anon' });
  assert.ok(!JSON.parse(next).items.some(p => p.id === first), 'a seen card must not come back');

  // Promotion is what sellers pay for, so it has to actually move a card up.
  const [[plain]] = await sql(`select deck('{}'::text[], '{}'::uuid[], 50, 0)::text;`, { role: 'anon' });
  const before = JSON.parse(plain).items.findIndex(p => p.title === 'Riso Print Quarterly');
  const [[rid]] = await sql(`select id from products where title = 'Riso Print Quarterly';`);
  await sql(`update products set promoted = true where id = '${rid}';`);
  const [[lifted]] = await sql(`select deck('{}'::text[], '{}'::uuid[], 50, 0)::text;`, { role: 'anon' });
  const after = JSON.parse(lifted).items.findIndex(p => p.title === 'Riso Print Quarterly');
  assert.ok(after < before, `promoting should lift a card: was ${before}, now ${after}`);
  await sql(`update products set promoted = false where id = '${rid}';`);
});

test('the deck never offers something out of stock or from a suspended shop', async () => {
  const [[sid]] = await sql(`select id from sellers where brand_name = 'Deck Shop';`);
  const [[pid]] = await sql(`select id from products where title = 'Kashmiri Chai Blend';`);
  await sql(`update products set stock = 0 where id = '${pid}';`);
  let [[out]] = await sql(`select deck('{}'::text[], '{}'::uuid[], 50, 0)::text;`, { role: 'anon' });
  assert.ok(!JSON.parse(out).items.some(p => p.id === pid), 'sold out must leave the deck');
  await sql(`update products set stock = 5 where id = '${pid}';`);

  await sql(`update sellers set status = 'suspended' where id = '${sid}';`);
  [[out]] = await sql(`select deck('{}'::text[], '{}'::uuid[], 50, 0)::text;`, { role: 'anon' });
  assert.equal(JSON.parse(out).items.filter(p => p.seller.id === sid).length, 0,
    'a suspended shop must vanish from the deck');
  await sql(`update sellers set status = 'active' where id = '${sid}';`);
});

test('search finds by word, by shop, and through a typo', async () => {
  const hits = async q => {
    const [[out]] = await sql(`select search_products('${q}', 20)::text;`, { role: 'anon' });
    return JSON.parse(out).items.map(p => p.title);
  };
  assert.ok((await hits('kurta')).includes('Chikankari Kurta'), 'plain word');
  assert.ok((await hits('Deck Shop')).length > 0, 'by shop name');
  assert.ok((await hits('kurat')).includes('Chikankari Kurta'), 'trigram should survive a typo');
  assert.equal((await hits('zzzznothing')).length, 0, 'and find nothing when there is nothing');
});

test('browse and products_by_id return only what a buyer may see', async () => {
  const [[out]] = await sql(`select browse('clothing', 50, 0)::text;`, { role: 'anon' });
  const items = JSON.parse(out).items;
  assert.ok(items.length >= 2);
  assert.ok(items.every(p => p.interest === 'clothing'));

  // A wishlist keeps its order, and a listing taken down simply drops out.
  const ids = items.map(p => p.id);
  await sql(`update products set status = 'removed' where id = '${ids[0]}';`);
  const [[byId]] = await sql(`select products_by_id(array['${ids[0]}','${ids[1]}']::uuid[])::text;`, { role: 'anon' });
  const back = JSON.parse(byId);
  assert.equal(back.length, 1, 'a removed listing must fall out of a wishlist');
  assert.equal(back[0].id, ids[1]);
  await sql(`update products set status = 'live' where id = '${ids[0]}';`);
});

test('a buyer can report a listing, once, and not a hundred times', async () => {
  const [[pid]] = await sql(`select id from products where title = 'Chikankari Kurta';`);
  const [[first]] = await sql(`select report_listing('${pid}', 'device-a', 'counterfeit', 'looks fake')::text;`, { role: 'anon' });
  assert.equal(JSON.parse(first).already, false);

  const [[again]] = await sql(`select report_listing('${pid}', 'device-a', 'counterfeit', '')::text;`, { role: 'anon' });
  assert.equal(JSON.parse(again).already, true, 'reporting twice is not two problems');

  assert.match(await fails(`select report_listing('${pid}', 'device-a', 'because-i-said-so', '');`, { role: 'anon' }),
    /reason we recognise/);

  // Ten in an hour from one device is not reporting, it is attacking a rival.
  for (let i = 0; i < 10; i++) {
    const [[p]] = await sql(`insert into products (seller_id, title, price, interest, city, stock, status)
      select seller_id, 'Spam Target ${i}', 100, 'clothing', 'Karachi', 1, 'live' from products where id = '${pid}' returning id;`);
    await sql(`select report_listing('${p}', 'device-spam', 'scam', '');`, { role: 'anon' }).catch(() => {});
  }
  assert.match(await fails(`select report_listing('${pid}', 'device-spam', 'scam', '');`, { role: 'anon' }),
    /too many reports/);
});

test('nobody can read the reports table, and only an admin sees the queue', async () => {
  assert.match(await fails('select * from reports;', { role: 'anon' }), /permission denied/i);
  assert.match(await fails('select * from reports;', { role: 'authenticated', uid: userA }), /permission denied/i);
  assert.match(await fails(`select admin_reports('open');`, { role: 'authenticated', uid: userA, email: 'seller@nova.test' }),
    /not permitted/);

  const [[out]] = await sql(`select admin_reports('open')::text;`, { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  const open = JSON.parse(out);
  assert.ok(open.length > 0);
  assert.ok(open[0].title && open[0].seller, 'a report is useless without the listing and the shop');

  const [[status]] = await sql(`select admin_resolve_report('${open[0].id}', 'dismissed');`,
                               { role: 'authenticated', uid: ADMIN_UID, email: ADMIN });
  assert.equal(status, 'dismissed');
});

test('events are collapsed into one row per product per day', async () => {
  const [[pid]] = await sql(`select id from products where title = 'Handblock Lawn Suit';`);
  const batch = JSON.stringify([
    ...Array(40).fill({ type: 'impression', product_id: pid }),
    ...Array(7).fill({ type: 'keep', product_id: pid }),
    { type: 'detail', product_id: pid },
    { type: 'add_to_bag', product_id: pid },
    { type: 'nonsense', product_id: pid },
    { type: 'impression', product_id: '00000000-0000-0000-0000-000000000000' }
  ]);
  await sql(`select record_events('${batch}'::jsonb);`, { role: 'anon' });

  const rows = await sql(`select impressions, keeps, detail_views, adds from product_stats
                          where product_id = '${pid}' and day = current_date;`);
  assert.equal(rows.length, 1, '49 events must be one row, not 49');
  assert.deepEqual(rows[0], ['40', '7', '1', '1']);

  // A second batch adds to the same row rather than starting another.
  await sql(`select record_events('${JSON.stringify([{ type: 'keep', product_id: pid }])}'::jsonb);`, { role: 'anon' });
  const [[keeps]] = await sql(`select keeps from product_stats where product_id = '${pid}' and day = current_date;`);
  assert.equal(keeps, '8');
});

test('a seller sees insights for their own listings only', async () => {
  const [[sid]] = await sql(`select id from sellers where brand_name = 'Deck Shop';`);
  const [[uid]] = await sql(`select user_id from seller_contacts where seller_id = '${sid}';`);
  const [[out]] = await sql(`select my_insights(30)::text;`, { role: 'authenticated', uid });
  const ins = JSON.parse(out);
  assert.ok(ins.totals.impressions >= 40);
  assert.ok(ins.products.length >= 4);
  assert.ok(ins.products.every(p => p.title), 'every row needs a name the seller recognises');

  // Another seller's numbers must not appear in it.
  const [[otherOut]] = await sql(`select my_insights(30)::text;`, { role: 'authenticated', uid: userA });
  const mine = new Set(ins.products.map(p => p.id));
  assert.ok(!JSON.parse(otherOut).products.some(p => mine.has(p.id)),
    'two sellers must never see the same listing in their insights');
});

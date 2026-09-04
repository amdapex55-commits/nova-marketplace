/* The seller workspace.
 *
 * Three jobs: get a seller signed in and registered, let them list products
 * with photographs, and show them the orders they have to deliver.
 *
 * Almost nothing here talks to a table directly. The rules — who owns what,
 * what may be published, which totals may be touched — live in
 * supabase/migrations as functions, where they are tested. This file is the
 * part a seller can see.
 */
import { auth, rpc, db, storage } from './sb.js';
import { prepare, baseKey, objectName, objectNames } from './photos.js';
import { el, esc, ICON, money, toast } from '../ui.js';
import { statusRail, pop } from '../motion.js';
import { adminSuite } from './admin.js';

const app = document.getElementById('app');
const INTERESTS = [
  ['clothing', 'Clothing'], ['sports', 'Sport'], ['food', 'Food'], ['magazines', 'Print']
];
const CONDITIONS = ['New', 'Like new', 'Gently used'];

let me = null;        // the seller row, or null before registration
let tab = 'listings';

const photoUrl = (key, variant = 'thumb') => storage.publicUrl(objectName(key, variant));

const fmtDate = iso => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });

function fail(err) {
  console.error(err);
  toast(err?.message || 'Something went wrong');
}

/* ------------------------------------------------------------------- signed out */

function signedOut() {
  let mode = 'in';
  const root = el('<div><div class="bar"><span class="mark">nova<em>.</em></span><span class="who"><b>For sellers</b></span></div><div id="pane"></div></div>');
  const pane = root.querySelector('#pane');

  const render = () => {
    pane.replaceChildren(el(`
      <div class="ob" style="padding:28px 18px">
        <h1>${mode === 'in' ? 'Sign in to your shop' : 'Open a shop on Nova'}</h1>
        <p class="sub">${mode === 'in'
          ? 'Your listings, your orders, your money — you collect it yourself on delivery.'
          : 'Free for your first month. You keep every rupee: buyers pay you directly, cash on delivery.'}</p>
      </div>`));

    const form = el(`
      <div class="group">
        <div class="inner">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com">
          </div>
          <div class="field">
            <label for="password">Password ${mode === 'up' ? '<span class="hint">at least 8 characters</span>' : ''}</label>
            <input id="password" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}">
            ${mode === 'up' ? '<div class="hint">There is no password reset yet — write this one down.</div>' : ''}
          </div>
          <button class="btn block" id="go">${mode === 'in' ? 'Sign in' : 'Create my account'}</button>
          <div class="err" id="err" role="alert" hidden></div>
          <button class="btn ghost block" id="swap">${mode === 'in' ? "I don't have an account yet" : 'I already have an account'}</button>
        </div>
      </div>`);
    pane.append(form);

    const err = form.querySelector('#err');
    const show = m => { err.hidden = false; err.textContent = m; };

    form.querySelector('#swap').addEventListener('click', () => { mode = mode === 'in' ? 'up' : 'in'; render(); });

    form.querySelector('#go').addEventListener('click', async () => {
      err.hidden = true;
      const email = form.querySelector('#email').value.trim();
      const password = form.querySelector('#password').value;
      if (!email.includes('@')) return show('Enter the email address you want to sign in with.');
      if (password.length < 8) return show('Passwords need at least 8 characters.');

      const btn = form.querySelector('#go');
      btn.disabled = true;
      btn.textContent = mode === 'in' ? 'Signing in…' : 'Creating…';
      try {
        if (mode === 'in') await auth.signIn(email, password);
        else await auth.signUp(email, password);
        await boot();
      } catch (e) {
        show(e.message || 'That did not work.');
        btn.disabled = false;
        btn.textContent = mode === 'in' ? 'Sign in' : 'Create my account';
      }
    });
  };
  render();
  return root;
}

/* --------------------------------------------------------------- registration */

function registerShop() {
  const root = el(`
    <div>
      <div class="bar"><span class="mark">nova<em>.</em></span><button class="btn ghost" id="out" style="min-height:34px;padding:0 12px;font-size:13px;margin-left:auto">Sign out</button></div>
      <div class="ob" style="padding:26px 18px 10px">
        <h1>Tell us about your shop</h1>
        <p class="sub">This is what buyers see on your listings. We check every new shop by hand before anything goes live — usually the same day.</p>
      </div>
      <div class="group">
        <div class="inner">
          <div class="field"><label for="brand">Shop or brand name</label><input id="brand" placeholder="Meher Studio"></div>
          <div class="field"><label for="owner">Your name</label><input id="owner" autocomplete="name"></div>
          <div class="field">
            <label for="phone">Mobile number <span class="hint">buyers and we will call this</span></label>
            <input id="phone" type="tel" inputmode="tel" placeholder="0300 1234567">
          </div>
          <div class="field">
            <label for="city">City you ship from <span class="hint">this sets delivery charges</span></label>
            <select id="city"><option value="">Select your city</option></select>
          </div>
          <div class="field"><label for="address">Pickup address</label><textarea id="address" placeholder="Shop number, street, area"></textarea></div>
          <button class="btn block" id="go">Open my shop</button>
          <div class="err" id="err" role="alert" hidden></div>
        </div>
      </div>
    </div>`);

  const city = root.querySelector('#city');
  for (const c of window.NOVAMKT.CITIES) city.append(el(`<option value="${esc(c)}">${esc(c)}</option>`));
  root.querySelector('#out').addEventListener('click', async () => { await auth.signOut(); boot(); });

  const err = root.querySelector('#err');
  root.querySelector('#go').addEventListener('click', async () => {
    err.hidden = true;
    const v = id => root.querySelector('#' + id).value.trim();
    if (v('brand').length < 2) { err.hidden = false; err.textContent = 'What is your shop called?'; return; }
    if (v('owner').length < 2) { err.hidden = false; err.textContent = 'We need your name.'; return; }
    if (!v('city')) { err.hidden = false; err.textContent = 'Pick the city you ship from.'; return; }
    if (v('address').length < 6) { err.hidden = false; err.textContent = 'Add the address we would collect from.'; return; }

    const btn = root.querySelector('#go');
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      me = await rpc('register_seller', {
        p_brand: v('brand'), p_owner: v('owner'), p_phone: v('phone').replace(/\D/g, ''),
        p_address: v('address'), p_city: v('city')
      });
      render();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Open my shop';
    }
  });
  return root;
}

/* -------------------------------------------------------------------- listings */

async function listings() {
  const wrap = el('<div class="rows"></div>');
  const rows = await db.select('products',
    'select=id,title,price,stock,status,interest,city,created_at,photos(key,position)&order=created_at.desc');

  if (!rows.length) {
    wrap.append(el(`
      <div class="empty">
        <h2>No listings yet</h2>
        <p>Add your first product. You can save it as a draft and publish when the photos are right.</p>
      </div>`));
    return wrap;
  }

  for (const p of rows) {
    const cover = [...(p.photos || [])].sort((a, b) => a.position - b.position)[0];
    const row = el(`
      <div class="row">
        <div class="ph">${cover ? `<img src="${esc(photoUrl(cover.key))}" alt="" loading="lazy">` : 'no photo'}</div>
        <div>
          <h3>${esc(p.title)}</h3>
          <div class="meta">
            <span class="num">${money(p.price)}</span>
            <span>·</span><span>${p.stock} in stock</span>
            <span class="state ${esc(p.status)}">${esc(p.status)}</span>
          </div>
        </div>
        <div class="acts">
          <button data-act="edit">Edit</button>
          <button data-act="toggle">${p.status === 'live' || p.status === 'pending' ? 'Unpublish' : 'Publish'}</button>
          <button data-act="del" class="warn">Delete</button>
        </div>
      </div>`);

    row.querySelector('[data-act=edit]').addEventListener('click', () => editor(p.id));
    row.querySelector('[data-act=toggle]').addEventListener('click', async ev => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        const live = !(p.status === 'live' || p.status === 'pending');
        const status = await rpc('publish_product', { p_product: p.id, p_live: live });
        toast(status === 'pending'
          ? 'Saved — it goes live as soon as your shop is approved'
          : status === 'live' ? 'Live now' : 'Unpublished');
        render();
      } catch (e) { fail(e); btn.disabled = false; }
    });
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm(`Delete “${p.title}”? This cannot be undone.`)) return;
      try {
        // The RPC hands back the photo keys precisely because Storage has no
        // cascade — deleting the row leaves the files, and the orphans then
        // collide with the next upload.
        const keys = await rpc('delete_product', { p_product: p.id });
        await storage.remove(keys.flatMap(objectNames));
        toast('Deleted');
        render();
      } catch (e) { fail(e); }
    });
    wrap.append(row);
  }
  return wrap;
}

/* ----------------------------------------------------------------- the editor */

async function editor(productId = null) {
  const existing = productId
    ? (await db.select('products', `id=eq.${productId}&select=*,photos(id,key,position)`))[0]
    : null;

  // { id, key?, preview, variants?, saved } — saved ones already exist in Storage.
  let photos = (existing?.photos || [])
    .sort((a, b) => a.position - b.position)
    .map(p => ({ rowId: p.id, key: p.key, preview: photoUrl(p.key), saved: true }));

  const sheet = el(`
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${existing ? 'Edit listing' : 'New listing'}">
      <div class="sheet-in">
        <div class="sheet-bar">
          <h2>${existing ? 'Edit listing' : 'New listing'}</h2>
          <button class="btn ghost" id="close" style="min-height:34px;padding:0 12px;font-size:13px">Close</button>
        </div>
        <div class="group" style="margin-top:14px">
          <div class="inner">
            <div class="field"><label for="title">Title</label><input id="title" maxlength="120" value="${esc(existing?.title || '')}" placeholder="Ajrak Cotton Kurta"></div>
            <div class="field"><label for="desc">Description</label><textarea id="desc" placeholder="What it is, what it is made of, how soon you ship it.">${esc(existing?.description || '')}</textarea></div>
            <div class="two-up">
              <div class="field"><label for="price">Price in rupees</label><input id="price" type="number" inputmode="numeric" min="1" value="${existing?.price || ''}"></div>
              <div class="field"><label for="stock">How many</label><input id="stock" type="number" inputmode="numeric" min="0" value="${existing?.stock ?? 1}"></div>
            </div>
            <div class="two-up">
              <div class="field"><label for="interest">Category</label><select id="interest"></select></div>
              <div class="field"><label for="condition">Condition</label><select id="condition"></select></div>
            </div>
            <div class="field">
              <label>Photos <span class="hint">first one is the card buyers swipe</span></label>
              <div class="thumbs" id="thumbs"></div>
              <input type="file" id="file" accept="image/*" multiple hidden>
            </div>
          </div>
        </div>
        <div class="pad" style="display:flex;flex-direction:column;gap:10px">
          <button class="btn block" id="save">${existing ? 'Save changes' : 'Save listing'}</button>
          <div class="err" id="err" role="alert" hidden></div>
        </div>
      </div>
    </div>`);

  const sel = (id, opts, current) => {
    const s = sheet.querySelector('#' + id);
    for (const [v, label] of opts) {
      s.append(el(`<option value="${esc(v)}"${current === v ? ' selected' : ''}>${esc(label)}</option>`));
    }
  };
  sel('interest', INTERESTS, existing?.interest || 'clothing');
  sel('condition', CONDITIONS.map(c => [c, c]), existing?.condition || 'New');

  const thumbs = sheet.querySelector('#thumbs');
  const file = sheet.querySelector('#file');

  const drawThumbs = () => {
    thumbs.replaceChildren();
    photos.forEach((p, i) => {
      const t = el(`
        <div class="thumb" data-photo="${esc(p.id || p.rowId || '')}">
          <img src="${esc(p.preview)}" alt="">
          ${i === 0 ? '<span class="badge">card</span>' : ''}
          <button aria-label="Remove photo">&times;</button>
        </div>`);
      t.querySelector('button').addEventListener('click', () => {
        photos.splice(i, 1);
        drawThumbs();
      });
      thumbs.append(t);
    });
    const add = el('<button class="picker" type="button"><span>+</span><span>Add photo</span></button>');
    add.addEventListener('click', () => file.click());
    thumbs.append(add);
  };
  drawThumbs();

  file.addEventListener('change', async () => {
    const picked = [...file.files];
    file.value = '';
    for (const f of picked) {
      try {
        // Resize before anything is uploaded: a 4 MB camera photo would
        // otherwise cost bandwidth twice and be shown to buyers once.
        const prepared = await prepare(f);
        photos.push({ ...prepared, saved: false });
        drawThumbs();
      } catch (e) { fail(e); }
    }
  });

  const close = () => sheet.remove();
  sheet.querySelector('#close').addEventListener('click', close);
  sheet.addEventListener('click', ev => { if (ev.target === sheet) close(); });

  const err = sheet.querySelector('#err');
  sheet.querySelector('#save').addEventListener('click', async () => {
    err.hidden = true;
    const v = id => sheet.querySelector('#' + id).value.trim();
    const price = Number(v('price'));
    const stock = Number(v('stock'));
    if (v('title').length < 3) { err.hidden = false; err.textContent = 'Give the listing a title.'; return; }
    if (!(price > 0)) { err.hidden = false; err.textContent = 'What does it cost?'; return; }
    if (!(stock >= 0)) { err.hidden = false; err.textContent = 'How many do you have?'; return; }

    const btn = sheet.querySelector('#save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const fields = {
        title: v('title'), description: v('desc'), price, stock,
        interest: v('interest'), condition: v('condition'),
        tags: [v('interest')], city: me.city
      };

      const row = existing
        ? (await db.update('products', `id=eq.${existing.id}`, fields))[0]
        : (await db.insert('products', { ...fields, seller_id: me.id, status: 'draft' }))[0];

      // Upload anything new. Each photo is three objects under one random id;
      // the row stores the id, not the variant.
      let uploaded = 0;
      for (const [i, p] of photos.entries()) {
        if (p.saved) continue;
        uploaded++;
        const key = baseKey(me.id, row.id, p.id);

        // A ring on the thumbnail itself, filled per variant. Three files go up
        // for every photograph, so a single spinner would sit still for most of
        // the wait and look stuck.
        const tile = sheet.querySelector(`.thumb[data-photo="${p.id}"]`);
        const ring = el(`
          <span class="ring" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <circle class="track" cx="16" cy="16" r="14"></circle>
              <circle class="bar" cx="16" cy="16" r="14"></circle>
            </svg>
          </span>`);
        tile?.append(ring);
        const bar = ring.querySelector('.bar');

        const variants = Object.entries(p.variants);
        for (const [n, [variant, out]] of variants.entries()) {
          btn.textContent = `Uploading ${i + 1} of ${photos.length}…`;
          await storage.upload(objectName(key, variant), out.blob);
          if (bar) bar.style.strokeDashoffset = String(88 - 88 * ((n + 1) / variants.length));
        }
        tile?.classList.add('done-upload');
        await db.insert('photos', {
          product_id: row.id, position: i, key,
          width: p.variants.full.width, height: p.variants.full.height
        });
        p.saved = true;
        p.key = key;
      }

      // Remove rows the seller deleted, and their objects with them.
      const kept = new Set(photos.filter(p => p.rowId).map(p => p.rowId));
      const dropped = (existing?.photos || []).filter(p => !kept.has(p.id));
      for (const d of dropped) {
        await db.remove('photos', `id=eq.${d.id}`);
        await storage.remove(objectNames(d.key));
      }

      // Positions may have shifted when one was removed.
      for (const [i, p] of photos.entries()) {
        if (p.rowId) await db.update('photos', `id=eq.${p.rowId}`, { position: i });
      }

      // Let the last ring visibly close before the sheet goes. Without this the
      // final frame of the upload is never seen — the work reads as having been
      // interrupted rather than finished.
      if (uploaded) await new Promise(r => setTimeout(r, 420));

      toast(existing ? 'Saved' : 'Listing saved as a draft');
      close();
      render();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = existing ? 'Save changes' : 'Save listing';
    }
  });

  document.body.append(sheet);
}

/* ---------------------------------------------------------------- order inbox */

const NEXT = {
  placed: [['confirmed', 'Confirm'], ['refused', 'Cannot fulfil']],
  confirmed: [['dispatched', 'Mark dispatched']],
  dispatched: [['delivered', 'Mark delivered'], ['refused', 'Refused at door']]
};

async function orders() {
  const parcels = await rpc('my_shipments');
  const wrap = el('<div></div>');

  if (!parcels.length) {
    wrap.append(el(`
      <div class="empty">
        <h2>No orders yet</h2>
        <p>When someone buys from you, the parcel and the buyer's address appear here.</p>
      </div>`));
    return wrap;
  }

  for (const s of parcels) {
    const card = el(`
      <div class="parcel">
        <div class="hd">
          <b>${esc(s.code)}</b>
          <span class="state ${esc(s.status)}">${esc(s.status)}</span>
          ${s.payment === 'cod'
            ? `<span class="state pending">collect ${money(s.total)}</span>`
            : '<span class="state draft">prepaid</span>'}
          <span class="when">${fmtDate(s.placed_at)}</span>
        </div>
        <ul>
          ${(s.lines || []).map(l => `<li><span>${esc(l.title)} × ${l.qty}</span><span class="num">${money(l.price * l.qty)}</span></li>`).join('')}
          <li><span>Delivery</span><span class="num">${s.delivery === 0 ? 'Free' : money(s.delivery)}</span></li>
        </ul>
        <div class="to">
          <b>${esc(s.buyer.name)}</b> · <a href="tel:${esc(s.buyer.phone)}">${esc(s.buyer.phone)}</a><br>
          ${esc(s.buyer.address)}, ${esc(s.buyer.area)}, ${esc(s.buyer.city)}
          ${s.buyer.landmark ? `<br><span style="color:var(--ink-faint)">Landmark: ${esc(s.buyer.landmark)}</span>` : ''}
          ${s.buyer.notes ? `<br><span style="color:var(--ink-faint)">Note: ${esc(s.buyer.notes)}</span>` : ''}
        </div>
        <div class="acts"></div>
      </div>`);

    card.querySelector('.to').insertAdjacentElement('beforebegin', statusRail(s.status));

    const acts = card.querySelector('.acts');
    for (const [status, label] of NEXT[s.status] || []) {
      const b = el(`<button class="btn ${status === 'refused' ? 'ghost' : ''}">${label}</button>`);
      b.addEventListener('click', async () => {
        if (status === 'refused' && !confirm('Mark this parcel as not fulfilled? The buyer will need to be told.')) return;
        b.disabled = true;
        try { await rpc('set_shipment_status', { p_shipment: s.id, p_status: status }); toast(label); render(); }
        catch (e) { fail(e); b.disabled = false; }
      });
      acts.append(b);
    }
    if (!acts.children.length) acts.append(el('<span style="font-size:13px;color:var(--ink-faint)">Closed</span>'));
    wrap.append(card);
  }
  return wrap;
}

/* ----------------------------------------------------------------- insights */
/* This is the screen a seller opens on day 25, deciding whether to pay. So it
   answers that directly and in their words: how many people saw it, how many
   saved it, how many bought it. No charts — a number they can act on beats a
   graph they have to interpret. */
async function insights() {
  const data = await rpc('my_insights', { p_days: 30 });
  const wrap = el('<div></div>');
  const t = data.totals;

  wrap.append(el(`
    <dl class="stats four">
      <div><dt>Seen</dt><dd class="num">${t.impressions.toLocaleString('en-PK')}</dd></div>
      <div><dt>Saved</dt><dd class="num">${t.keeps.toLocaleString('en-PK')}</dd></div>
      <div><dt>Opened</dt><dd class="num">${t.detail_views.toLocaleString('en-PK')}</dd></div>
      <div><dt>Sold</dt><dd class="num">${money(t.sold)}</dd></div>
    </dl>`));

  if (!t.impressions) {
    wrap.append(el(`
      <div class="notice info">
        <div>Nothing to show yet — these fill up once your listings are live and
        buyers start swiping. <b>Seen</b> is how many times a card appeared,
        <b>saved</b> is a swipe right.</div>
      </div>`));
  }

  const rows = el('<div class="group"><header><h2>Last 30 days</h2><span class="note">per listing</span></header></div>');
  if (!data.products.length) {
    rows.append(el('<div class="empty"><h2>No listings yet</h2><p>Add one and its numbers appear here.</p></div>'));
  }
  for (const p of data.products) {
    // Save rate is the honest signal: plenty of impressions and almost no saves
    // means the photograph or the price is the problem, not the reach.
    const rate = p.impressions ? Math.round((p.keeps / p.impressions) * 100) : null;
    rows.append(el(`
      <div class="row">
        <div class="ph">${p.photo_key ? `<img src="${esc(photoUrl(p.photo_key))}" alt="" loading="lazy">` : 'no photo'}</div>
        <div>
          <h3>${esc(p.title)} <span class="state ${esc(p.status)}">${esc(p.status)}</span>${p.promoted ? '<span class="state live">promoted</span>' : ''}</h3>
          <div class="meta">
            <span><b class="num">${p.impressions}</b> seen</span><span>·</span>
            <span><b class="num">${p.keeps}</b> saved</span><span>·</span>
            <span><b class="num">${p.detail_views}</b> opened</span><span>·</span>
            <span><b class="num">${p.ordered}</b> ordered</span>
          </div>
          ${rate !== null ? `<div class="meta"><span>${rate}% of the people who saw it saved it${
            p.impressions >= 30 && rate < 5 ? ' — worth trying a different first photo' : ''}</span></div>` : ''}
        </div>
        <div class="acts"></div>
      </div>`));
  }
  wrap.append(rows);
  return wrap;
}

/* --------------------------------------------------------------------- shop */

function shop() {
  const wrap = el(`
    <div>
      <div class="group">
        <header><h2>Your shop</h2><span class="state ${esc(me.status)}">${esc(me.status)}</span></header>
        <div class="inner">
          <div class="field"><label for="s-brand">Shop name</label><input id="s-brand" value="${esc(me.brand_name)}"></div>
          <div class="field"><label for="s-city">City you ship from</label><select id="s-city"></select></div>
          <div class="field"><label for="s-phone">Mobile number</label><input id="s-phone" type="tel" inputmode="tel" value="${esc(me.phone)}"></div>
          <div class="field"><label for="s-address">Pickup address</label><textarea id="s-address">${esc(me.address)}</textarea></div>
          <button class="btn block" id="s-save">Save</button>
          <div class="err" id="s-err" role="alert" hidden></div>
        </div>
      </div>
      <div class="group">
        <header><h2>Your plan</h2></header>
        <div class="inner" style="gap:6px">
          <div style="font-size:15px">Free until <b>${fmtDate(me.trial_ends_at)}</b>.</div>
          <div style="font-size:14px;color:var(--ink-soft)">After that it is a flat monthly fee. We never take a cut of your sales — buyers pay you directly and you keep all of it.</div>
        </div>
      </div>
      <div class="pad" style="padding-bottom:24px"><button class="btn ghost block" id="s-out">Sign out</button></div>
    </div>`);

  const city = wrap.querySelector('#s-city');
  for (const c of window.NOVAMKT.CITIES) {
    city.append(el(`<option value="${esc(c)}"${c === me.city ? ' selected' : ''}>${esc(c)}</option>`));
  }

  const err = wrap.querySelector('#s-err');
  wrap.querySelector('#s-save').addEventListener('click', async ev => {
    err.hidden = true;
    ev.currentTarget.disabled = true;
    try {
      me = await rpc('update_shopfront', {
        p_brand: wrap.querySelector('#s-brand').value.trim(),
        p_city: wrap.querySelector('#s-city').value,
        p_phone: wrap.querySelector('#s-phone').value.replace(/\D/g, ''),
        p_address: wrap.querySelector('#s-address').value.trim()
      });
      toast('Saved');
      render();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      ev.currentTarget.disabled = false;
    }
  });
  wrap.querySelector('#s-out').addEventListener('click', async () => { await auth.signOut(); me = null; boot(); });
  return wrap;
}

/* ------------------------------------------------------------------- shell */

async function render() {
  me = await rpc('me');
  if (!me) { app.replaceChildren(registerShop()); return; }


  const shell = el(`
    <div>
      <div class="bar">
        <span class="mark">nova<em>.</em></span>
        <span class="state ${esc(me.status)}">${esc(me.status)}</span>
        <span class="who"><b>${esc(me.brand_name)}</b><span>${esc(me.city)}</span></span>
      </div>
      <nav class="nav">
        <button data-tab="listings">Listings<span class="count num">${me.products}</span></button>
        <button data-tab="orders">Orders<span class="count num">${me.open_orders}</span></button>
        <button data-tab="insights">Insights</button>
        <button data-tab="shop">Shop</button>
      </nav>
      <dl class="stats">
        <div><dt>Live</dt><dd class="num">${me.live_products}</dd></div>
        <div><dt>Listings</dt><dd class="num">${me.products}</dd></div>
        <div><dt>To deliver</dt><dd class="num">${me.open_orders}</dd></div>
      </dl>
      <div id="pane"></div>
    </div>`);

  for (const b of shell.querySelectorAll('.nav button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
  }

  if (me.status === 'pending') {
    shell.querySelector('#pane').append(el(`
      <div class="notice warn">
        <div><b>Your shop is being checked.</b> You can add listings now — they go live the moment we approve you, usually the same day. We check every new shop by hand so buyers can trust what they swipe.</div>
      </div>`));
  }
  if (me.status === 'suspended') {
    shell.querySelector('#pane').append(el(
      '<div class="notice bad"><div><b>Your shop is suspended.</b> Nothing is visible to buyers. Contact us to sort it out.</div></div>'));
  }

  app.replaceChildren(shell);
  const pane = shell.querySelector('#pane');

  if (tab === 'listings') {
    const add = el('<div class="pad" style="padding-bottom:12px"><button class="btn block">Add a listing</button></div>');
    add.querySelector('button').addEventListener('click', () => editor());
    pane.append(add, await listings());
  } else if (tab === 'orders') {
    pane.append(await orders());
  } else if (tab === 'insights') {
    pane.append(await insights());
  } else {
    pane.append(shop());
  }
  app.setAttribute('aria-busy', 'false');
}

/* Which suite a signed-in account gets.
 *
 * Postgres answers this, not the browser: is_admin() reads a table that has no
 * grant for anyone, and every function the control screens call re-checks it.
 * So this is a routing decision about what to draw, and carries no authority of
 * its own — an account that is not in `admins` gets refused by the database
 * whatever this returns.
 *
 * `preferShop` lets an account that is both switch back to its own workspace.
 */
let preferShop = false;

async function boot() {
  app.setAttribute('aria-busy', 'true');
  if (!auth.signedIn) { app.replaceChildren(signedOut()); app.setAttribute('aria-busy', 'false'); return; }
  try {
    const [control, shop] = await Promise.all([rpc('is_admin'), rpc('me')]);
    me = shop;
    if (control && !preferShop) {
      await adminSuite({
        alsoASeller: !!shop,
        onSwitchToShop: () => { preferShop = true; boot(); }
      });
      return;
    }
    await render();
  } catch (err) {
    // An expired or revoked session should return someone to the sign-in
    // screen, not to an error they can do nothing about.
    if (err.status === 401 || err.status === 403) {
      await auth.signOut();
      app.replaceChildren(signedOut());
    } else {
      fail(err);
      app.replaceChildren(el(
        '<div class="empty"><h2>Could not open your workspace</h2><p>Reload the page. If it keeps happening the connection dropped mid-load.</p></div>'));
    }
    app.setAttribute('aria-busy', 'false');
  }
}

boot();

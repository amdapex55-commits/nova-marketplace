/* The admin suite.
 *
 * Reached through the same sign-in as the workspace rather than a second door,
 * because a second login is a second thing to secure and a second thing to
 * forget. Which suite renders is decided by is_admin(), and that answer comes
 * from Postgres.
 *
 * What the front end does here is *draw*. It never decides what is allowed:
 * every function called below re-checks `admins` server-side and refuses a
 * caller who is not in it, so nothing is protected by this file being hard to
 * find. It could be published on the homepage and grant nobody anything.
 */
import { auth, rpc, storage } from './sb.js';
import { objectName } from './photos.js';
import { el, esc, money, toast } from '../ui.js';
import { statusRail } from '../motion.js';

const photoUrl = (key, variant = 'thumb') => storage.publicUrl(objectName(key, variant));
const fmtDate = iso => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' });
const fmtFull = iso => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });

let tab = 'queue';

function fail(err) {
  console.error(err);
  toast(err?.message || 'Something went wrong');
}

/* ------------------------------------------------------------------ queue -- */
/* Everything waiting on a decision, in one place. This is the screen that gets
   opened daily; the others are for looking things up. */
async function queue(refresh) {
  const [sellers, listings] = await Promise.all([
    rpc('admin_sellers', { p_status: 'pending' }),
    rpc('admin_listings', { p_status: 'pending' })
  ]);

  const wrap = el('<div></div>');

  if (!sellers.length && !listings.length) {
    wrap.append(el(`
      <div class="empty">
        <h2>Nothing waiting</h2>
        <p>New shops and the listings behind them land here. Approving a shop releases everything it has queued.</p>
      </div>`));
    return wrap;
  }

  if (sellers.length) {
    const group = el(`<div class="group"><header><h2>Shops waiting</h2><span class="note">${sellers.length}</span></header></div>`);
    for (const s of sellers) group.append(sellerRow(s, refresh, { compact: true }));
    wrap.append(group);
  }

  if (listings.length) {
    const group = el(`
      <div class="group">
        <header><h2>Listings waiting</h2><span class="note">${listings.length}</span></header>
      </div>`);
    group.append(el(`
      <div class="notice info" style="margin:0;border-radius:0">
        <div>These belong to shops that are not approved yet. Approve the shop and they go live together — you rarely need to touch them one by one.</div>
      </div>`));
    for (const p of listings) group.append(listingRow(p, refresh));
    wrap.append(group);
  }
  return wrap;
}

/* ---------------------------------------------------------------- sellers -- */
function sellerRow(s, refresh, { compact = false } = {}) {
  const row = el(`
    <div class="row admin-row">
      <div class="ph mono">${esc((s.brand_name || '?').slice(0, 2).toUpperCase())}</div>
      <div>
        <h3>${esc(s.brand_name)} <span class="state ${esc(s.status)}">${esc(s.status)}</span></h3>
        <div class="meta">
          <span>${esc(s.owner_name || '—')}</span>
          <a href="tel:${esc(s.phone || '')}">${esc(s.phone || 'no phone')}</a>
          <span>·</span><span>${esc(s.city)}</span>
        </div>
        <div class="meta">
          <span>${s.listings} listings</span><span>·</span>
          <span>${s.live} live</span><span>·</span>
          <span>${s.parcels} parcels</span><span>·</span>
          <span class="num">${money(s.gmv)} sold</span>
        </div>
        ${compact ? '' : `<div class="meta"><span>${s.plan === 'monthly' ? 'Paid until' : 'Trial ends'} ${fmtFull(s.trial_ends_at)}</span></div>`}
        ${s.address ? `<div class="meta addr">${esc(s.address)}</div>` : ''}
      </div>
      <div class="acts"></div>
    </div>`);

  const acts = row.querySelector('.acts');
  const act = (label, fn, cls = '') => {
    const b = el(`<button class="${cls}">${label}</button>`);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); await refresh(); } catch (e) { fail(e); b.disabled = false; }
    });
    acts.append(b);
  };

  if (s.status !== 'active') {
    act('Approve', async () => {
      const out = await rpc('admin_set_seller_status', { p_seller: s.id, p_status: 'active' });
      toast(out.released ? `Approved — ${out.released} listing${out.released === 1 ? '' : 's'} live` : 'Approved');
    });
  }
  if (s.status === 'active') {
    act('Suspend', async () => {
      if (!confirm(`Suspend ${s.brand_name}? Their listings come out of the deck immediately.`)) throw new Error('cancelled');
      await rpc('admin_set_seller_status', { p_seller: s.id, p_status: 'suspended' });
      toast('Suspended');
    }, 'warn');
    act(s.plan === 'monthly' ? 'Add a month' : 'Mark paid', async () => {
      const out = await rpc('admin_set_seller_plan', { p_seller: s.id, p_plan: 'monthly', p_months: 1 });
      toast(`Paid until ${fmtFull(out.paid_until)}`);
    });
  }
  return row;
}

async function sellers(refresh, status) {
  const rows = await rpc('admin_sellers', { p_status: status });
  const wrap = el('<div class="rows"></div>');
  if (!rows.length) { wrap.append(el('<div class="empty"><h2>No shops here</h2><p>Nothing matches this filter.</p></div>')); return wrap; }
  for (const s of rows) wrap.append(sellerRow(s, refresh));
  return wrap;
}

/* --------------------------------------------------------------- listings -- */
function listingRow(p, refresh) {
  const cover = p.photos?.[0];
  const row = el(`
    <div class="row admin-row${p.promoted ? ' promoted' : ''}">
      <div class="ph">${cover ? `<img src="${esc(photoUrl(cover))}" alt="" loading="lazy">` : 'no photo'}</div>
      <div>
        <h3>${esc(p.title)} <span class="state ${esc(p.status)}">${esc(p.status)}</span>${p.promoted ? '<span class="state live">promoted</span>' : ''}</h3>
        <div class="meta">
          <span class="num">${money(p.price)}</span><span>·</span>
          <span>${p.stock} in stock</span><span>·</span>
          <span>${esc(p.interest)}</span>
        </div>
        <div class="meta"><span>${esc(p.seller)}</span><span>·</span><span>${esc(p.city)}</span><span>·</span><span>${fmtDate(p.created_at)}</span></div>
      </div>
      <div class="acts"></div>
    </div>`);

  const acts = row.querySelector('.acts');
  const act = (label, fn, cls = '') => {
    const b = el(`<button class="${cls}">${label}</button>`);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); await refresh(); } catch (e) { fail(e); b.disabled = false; }
    });
    acts.append(b);
  };

  if (p.status === 'live') {
    act('Take down', async () => {
      if (!confirm(`Take “${p.title}” out of the deck?`)) throw new Error('cancelled');
      await rpc('admin_set_product_status', { p_product: p.id, p_status: 'removed' });
      toast('Taken down');
    }, 'warn');
    act(p.promoted ? 'Stop promoting' : 'Promote', async () => {
      await rpc('admin_set_promoted', { p_product: p.id, p_promoted: !p.promoted });
      toast(p.promoted ? 'No longer promoted' : 'Promoted');
    });
  } else if (p.status === 'pending' && p.seller_status === 'active') {
    act('Publish', async () => {
      await rpc('admin_set_product_status', { p_product: p.id, p_status: 'live' });
      toast('Live');
    });
  } else if (p.status === 'removed') {
    act('Restore', async () => {
      await rpc('admin_set_product_status', { p_product: p.id, p_status: 'pending' });
      toast('Restored — publish it when you are happy');
    });
  }
  return row;
}

async function listings(refresh, status) {
  const rows = await rpc('admin_listings', { p_status: status });
  const wrap = el('<div class="rows"></div>');
  if (!rows.length) { wrap.append(el('<div class="empty"><h2>No listings here</h2><p>Nothing matches this filter.</p></div>')); return wrap; }
  for (const p of rows) wrap.append(listingRow(p, refresh));
  return wrap;
}

/* ----------------------------------------------------------------- orders -- */
async function orders() {
  const rows = await rpc('admin_orders', { p_limit: 60 });
  const wrap = el('<div></div>');
  if (!rows.length) {
    wrap.append(el('<div class="empty"><h2>No orders yet</h2><p>Every order across the marketplace appears here.</p></div>'));
    return wrap;
  }
  for (const o of rows) {
    const card = el(`
      <div class="parcel">
        <div class="hd">
          <b>${esc(o.code)}</b>
          <span class="state ${o.payment === 'cod' ? 'pending' : 'draft'}">${o.payment === 'cod' ? 'cash on delivery' : 'prepaid'}</span>
          <span class="when">${fmtFull(o.placed_at)}</span>
        </div>
        <ul>
          ${(o.parcels || []).map(p =>
            `<li><span>${esc(p.seller)} <span class="state ${esc(p.status)}">${esc(p.status)}</span></span><span class="num">${money(p.total)}</span></li>`).join('')}
        </ul>
        <div class="to"><b>${esc(o.buyer)}</b> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a> · ${esc(o.city)}
          <span style="float:right" class="num"><b>${money(o.total)}</b></span></div>
      </div>`);
    // One rail per order, at the least-advanced parcel: an order is only really
    // delivered when its slowest seller has delivered.
    const order = ['placed', 'confirmed', 'dispatched', 'delivered'];
    const worst = (o.parcels || []).reduce((acc, p) =>
      order.indexOf(p.status) < order.indexOf(acc) ? p.status : acc, 'delivered');
    card.querySelector('.to').insertAdjacentElement('beforebegin', statusRail(worst));
    wrap.append(card);
  }
  return wrap;
}

/* ------------------------------------------------------------------ shell -- */
export async function adminSuite({ alsoASeller, onSwitchToShop }) {
  const app = document.getElementById('app');
  let filter = null;

  async function render() {
    const stats = await rpc('admin_overview');
    const shell = el(`
      <div class="admin">
        <div class="bar">
          <span class="mark">nova<em>.</em></span>
          <span class="state active">control</span>
          <span class="who"><b>Marketplace</b><span>${stats.sellers_active} shops · ${stats.listings_live} live</span></span>
        </div>
        <nav class="nav">
          <button data-tab="queue">Queue<span class="count num">${stats.sellers_pending + stats.listings_pending}</span></button>
          <button data-tab="sellers">Shops<span class="count num">${stats.sellers_active}</span></button>
          <button data-tab="listings">Listings<span class="count num">${stats.listings_live}</span></button>
          <button data-tab="orders">Orders<span class="count num">${stats.orders_total}</span></button>
        </nav>
        <dl class="stats four">
          <div><dt>Waiting</dt><dd class="num">${stats.sellers_pending}</dd></div>
          <div><dt>Live listings</dt><dd class="num">${stats.listings_live}</dd></div>
          <div><dt>Open parcels</dt><dd class="num">${stats.parcels_open}</dd></div>
          <div><dt>Sold, all time</dt><dd class="num">${money(stats.gmv_total)}</dd></div>
        </dl>
        <div id="pane"></div>
      </div>`);

    for (const b of shell.querySelectorAll('.nav button')) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => { tab = b.dataset.tab; filter = null; render(); });
    }

    app.replaceChildren(shell);
    const pane = shell.querySelector('#pane');

    if (stats.trials_ending > 0 && tab === 'queue') {
      pane.append(el(`
        <div class="notice warn">
          <div><b>${stats.trials_ending} shop${stats.trials_ending === 1 ? "'s trial ends" : "s' trials end"} within a week.</b>
          Whether they renew is the whole business — talk to them before the date, not after.</div>
        </div>`));
    }

    const chips = opts => {
      const bar = el('<div class="chips"></div>');
      for (const [value, label] of opts) {
        const c = el(`<button class="chip" aria-pressed="${filter === value}">${label}</button>`);
        c.addEventListener('click', () => { filter = value; render(); });
        bar.append(c);
      }
      pane.append(bar);
    };

    if (tab === 'queue') pane.append(await queue(render));
    else if (tab === 'sellers') {
      chips([[null, 'All'], ['pending', 'Waiting'], ['active', 'Active'], ['suspended', 'Suspended']]);
      pane.append(await sellers(render, filter));
    } else if (tab === 'listings') {
      chips([[null, 'All'], ['live', 'Live'], ['pending', 'Waiting'], ['removed', 'Taken down']]);
      pane.append(await listings(render, filter));
    } else {
      pane.append(await orders());
    }

    const foot = el('<div class="pad" style="padding:16px 14px 26px;display:flex;flex-direction:column;gap:10px"></div>');
    if (alsoASeller) {
      const b = el('<button class="btn ghost block">Open my own shop instead</button>');
      b.addEventListener('click', onSwitchToShop);
      foot.append(b);
    }
    const out = el('<button class="btn ghost block">Sign out</button>');
    out.addEventListener('click', async () => { await auth.signOut(); location.reload(); });
    foot.append(out);
    pane.append(foot);

    app.setAttribute('aria-busy', 'false');
  }

  await render();
}

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

/* ---------------------------------------------------------------- reports -- */
async function reports(refresh) {
  const rows = await rpc('admin_reports', { p_status: 'open' });
  const wrap = el('<div class="rows"></div>');
  if (!rows.length) {
    wrap.append(el('<div class="empty"><h2>Nothing reported</h2><p>Buyers can report any listing. What they send lands here.</p></div>'));
    return wrap;
  }
  for (const r of rows) {
    const row = el(`
      <div class="row admin-row">
        <div class="ph mono">!</div>
        <div>
          <h3>${esc(r.title)} <span class="state pending">${esc(r.reason)}</span>${
            r.others > 0 ? `<span class="state refused">${r.others + 1} reports</span>` : ''}</h3>
          <div class="meta"><span>${esc(r.seller)}</span><span>·</span><span class="state ${esc(r.product_status)}">${esc(r.product_status)}</span><span>·</span><span>${fmtFull(r.created_at)}</span></div>
          ${r.detail ? `<div class="meta addr">“${esc(r.detail)}”</div>` : ''}
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
    if (r.product_status === 'live') {
      act('Take down', async () => {
        // Taking the listing down and closing the report are one decision, so
        // they are one click. Two buttons means half-done queues.
        await rpc('admin_set_product_status', { p_product: r.product_id, p_status: 'removed' });
        await rpc('admin_resolve_report', { p_report: r.id, p_status: 'actioned' });
        toast('Taken down');
      }, 'warn');
    }
    act('Dismiss', async () => {
      await rpc('admin_resolve_report', { p_report: r.id, p_status: 'dismissed' });
      toast('Dismissed');
    });
    wrap.append(row);
  }
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

/* -------------------------------------------------------------- analytics -- */
/* Everything, for whoever runs the place. Sellers see their own funnel in the
   workspace; this is the half that is about the marketplace rather than about
   one shop, and it stays here. */
async function analytics() {
  const a = await rpc('admin_analytics', { p_days: 14 });
  const wrap = el('<div></div>');
  const n = v => Number(v || 0);
  const pct = (x, y) => (n(y) ? Math.round((n(x) / n(y)) * 1000) / 10 : null);
  const f = a.funnel;

  wrap.append(el(`
    <dl class="stats four">
      <div><dt>Orders today</dt><dd class="num">${n(a.live.orders_today)}</dd></div>
      <div><dt>Sold today</dt><dd class="num">${money(a.live.gmv_today)}</dd></div>
      <div><dt>Cancelled</dt><dd class="num">${a.live.cancel_rate === null ? '—' : a.live.cancel_rate + '%'}</dd></div>
      <div><dt>Customer refs</dt><dd class="num">${a.refs.used}<small> / ${a.refs.total}</small></dd></div>
    </dl>`));

  // Four digits is a hard ceiling, so say so before it becomes an outage.
  if (Number(a.refs.pct) > 70) {
    wrap.append(el(`<div class="notice bad"><div><b>Customer references are ${a.refs.pct}% used.</b>
      Four digits allows ${a.refs.total}. Widen to five before they run out.</div></div>`));
  }

  const steps = [
    ['Added to a bag', f.bag_add],
    ['Asked to sign up', f.gate_seen],
    ['Signed up', f.signup_done],
    ['Started checkout', f.checkout_start],
    ['Ordered', f.order_placed]
  ];
  const top = Math.max(1, n(f.bag_add));
  const funnel = el(`<div class="group"><header><h2>Last 14 days</h2><span class="note">where buyers drop off</span></header><div class="funnel"></div></div>`);
  steps.forEach(([label, v], i) => {
    const rate = i ? pct(v, steps[i - 1][1]) : null;
    funnel.querySelector('.funnel').append(el(`
      <div class="step">
        <div class="step-head"><b>${label}</b><span class="num">${n(v).toLocaleString('en-PK')}</span>
          ${rate === null ? '' : `<i class="${rate < 40 ? 'weak' : ''}">${rate}%</i>`}</div>
        <div class="step-bar"><b style="width:${Math.max(1.5, (n(v) / top) * 100)}%"></b></div>
      </div>`));
  });
  if (n(f.gate_cancelled)) {
    funnel.append(el(`<div class="notice warn" style="margin:0 15px 15px"><div>
      <b>${n(f.gate_cancelled)} people backed out at the sign-up screen.</b>
      That is the cost of asking for an account at the bag — worth watching against orders.</div></div>`));
  }
  wrap.append(funnel);

  /* Searches that found nothing are the most actionable rows here: each one is
     somebody who wanted to buy something we do not stock. */
  const empty = el(`<div class="group"><header><h2>Searched for, found nothing</h2><span class="note">what to recruit</span></header></div>`);
  if (!a.empty_searches.length) {
    empty.append(el('<div class="empty"><p>Nothing yet — every search so far returned something.</p></div>'));
  } else {
    for (const e of a.empty_searches) {
      empty.append(el(`<div class="row admin-row"><div class="ph mono">?</div>
        <div><h3>“${esc(e.q)}”</h3><div class="meta"><span>${e.n} time${e.n === 1 ? '' : 's'}</span></div></div>
        <div class="acts"></div></div>`));
    }
  }
  wrap.append(empty);

  const screens = el(`<div class="group"><header><h2>Most opened screens</h2></header><div class="funnel"></div></div>`);
  const stop = Math.max(1, ...a.screens.map(x => n(x.n)));
  for (const sc of a.screens) {
    screens.querySelector('.funnel').append(el(`
      <div class="step">
        <div class="step-head"><b>${esc(sc.name || 'deck')}</b><span class="num">${n(sc.n)}</span></div>
        <div class="step-bar"><b style="width:${Math.max(1.5, (n(sc.n) / stop) * 100)}%"></b></div>
      </div>`));
  }
  wrap.append(screens);

  const stalls = n(a.totals.stall);
  if (stalls) {
    wrap.append(el(`<div class="notice info"><div><b>${stalls} long pauses</b> on a screen with no
      navigation in 25 seconds. Reading, stuck, or gone — the screens list above says which.</div></div>`));
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
          <button data-tab="reports">Reports<span class="count num">${stats.reports_open}</span></button>
          <button data-tab="analytics">Analytics</button>
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

    if (stats.reports_open > 0 && tab === 'queue') {
      const n = el(`<div class="notice bad"><div><b>${stats.reports_open} reported listing${
        stats.reports_open === 1 ? '' : 's'}.</b> A buyer flagged something — worth looking before anything else.</div></div>`);
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => { tab = 'reports'; render(); });
      pane.append(n);
    }
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
    } else if (tab === 'reports') {
      pane.append(await reports(render));
    } else if (tab === 'analytics') {
      pane.append(await analytics());
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

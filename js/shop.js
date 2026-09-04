/* Screens added in the second wave: the variant picker, a shop's own page,
 * messages, reviews, and the offers feed.
 *
 * Kept out of views.js because that file is already the four original screens
 * and this is a different job — but it uses the same tile() so the grid looks
 * identical wherever it appears.
 */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON, money, toast } from './ui.js';
import { burst, pop } from './motion.js';
import { account } from './account.js';

const STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/></svg>';

export const stars = (n, count = null) => {
  const filled = Math.round(Number(n) || 0);
  return `<span class="stars" role="img" aria-label="${filled} out of 5">${
    [1, 2, 3, 4, 5].map(i => `<span class="${i <= filled ? 'on' : 'off'}">${STAR}</span>`).join('')
  }</span>${count !== null ? `<span style="font-size:13px;color:var(--ink-faint);margin-left:6px">${count}</span>` : ''}`;
};

export const initials = name =>
  (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* Rs 3,200 with the old price struck through and the size of the cut, when
   there is one. Everywhere a price appears, so a sale never shows in one place
   and not another. */
export function priceHtml(p) {
  if (!p.was) return `<span class="num">${money(p.price)}</span>`;
  const cut = Math.round((1 - p.price / p.was) * 100);
  return `<span class="num">${money(p.price)}</span><span class="was num">${money(p.was)}</span>` +
         `<span class="cut">−${cut}%</span>`;
}

/* ---------------------------------------------------------- the promises --- */
/* The three things a buyer actually worries about before paying a stranger cash
   at their door. They belong at the point of decision — on the listing, in the
   bag and on the order — not behind a link to a terms page nobody opens.
   Every one is enforced by the code: the cancel window is a real 24 hours in
   cancel_order(), the money genuinely never passes through us, and refusing a
   parcel costs nothing because nothing has been charged. */
export const POLICIES = [
  ['shield', 'Check it at the door', 'Open the parcel before you pay the rider. Not what was listed? Do not take it — refusing costs you nothing.'],
  ['clock', 'Free to cancel for 24 hours', 'Changed your mind? Cancel from your order page any time in the first day, as long as it has not been posted.'],
  ['cash', 'Cash on delivery', 'Pay the seller when it arrives. Nova never holds your money and never asks for a card.']
];

const POLICY_ICON = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/></svg>'
};

export function policyStrip({ compact = false } = {}) {
  const wrap = el(`<div class="policies${compact ? ' compact' : ''}"></div>`);
  for (const [icon, title, body] of POLICIES) {
    wrap.append(el(`
      <div class="policy">
        <span class="policy-i" aria-hidden="true">${POLICY_ICON[icon]}</span>
        <div><b>${esc(title)}</b>${compact ? '' : `<span>${esc(body)}</span>`}</div>
      </div>`));
  }
  if (!compact) {
    wrap.append(el('<a class="policy-more" href="#/legal">Read the full terms</a>'));
  }
  return wrap;
}

/* --------------------------------------------------------- variant picker -- */
/* Returns { node, selected(), require() }. `require()` shakes the row and
   returns false when nothing is picked — a nudge rather than a red error,
   because not having chosen yet is not a mistake. */
export function variantPicker(product) {
  const variants = product.variants || [];
  const node = el('<div style="display:flex;flex-direction:column;gap:16px"></div>');
  if (!variants.length) return { node, selected: () => null, require: () => true };

  const colours = [...new Map(variants.filter(v => v.colour)
    .map(v => [v.colour, { name: v.colour, hex: v.colour_hex }])).values()];
  const sizes = [...new Set(variants.filter(v => v.size).map(v => v.size))];

  let colour = colours.length === 1 ? colours[0].name : null;
  let size = null;

  const stockFor = (s, c) => variants
    .filter(v => (s == null || v.size === s) && (c == null || v.colour === c))
    .reduce((n, v) => n + v.stock, 0);

  let colourRow, sizeRow;

  const drawColours = () => {
    if (!colours.length) return;
    colourRow.querySelector('.swatches').replaceChildren(...colours.map(c => {
      const out = stockFor(null, c.name) === 0;
      const b = el(`<button class="swatch" aria-pressed="${colour === c.name}" ${out ? 'disabled' : ''}
        style="background:${esc(c.hex || '#ccc')}" aria-label="${esc(c.name)}${out ? ', sold out' : ''}"></button>`);
      b.addEventListener('click', () => {
        colour = colour === c.name ? null : c.name;
        // Picking a colour can invalidate the chosen size, so clear it rather
        // than leaving a combination that does not exist selected.
        if (size && stockFor(size, colour) === 0) size = null;
        draw();
      });
      return b;
    }));
    colourRow.querySelector('.pickname').textContent = colour || 'Pick a colour';
  };

  const drawSizes = () => {
    if (!sizes.length) return;
    sizeRow.querySelector('.sizes').replaceChildren(...sizes.map(s => {
      const left = stockFor(s, colour);
      const b = el(`<button class="size" aria-pressed="${size === s}" ${left === 0 ? 'disabled' : ''}>
        ${esc(s)}${left > 0 && left <= 3 ? `<span class="left">${left}</span>` : ''}</button>`);
      b.addEventListener('click', () => { size = size === s ? null : s; draw(); });
      return b;
    }));
  };

  const draw = () => { drawColours(); drawSizes(); };

  if (colours.length) {
    colourRow = el(`<div>
      <div class="pickhead"><span>Colour</span><b class="pickname"></b></div>
      <div class="swatches"></div></div>`);
    node.append(colourRow);
  }
  if (sizes.length) {
    sizeRow = el(`<div>
      <div class="pickhead"><span>Size</span></div>
      <div class="sizes"></div></div>`);
    node.append(sizeRow);
  }
  draw();

  const selected = () => variants.find(v =>
    (!sizes.length || v.size === size) && (!colours.length || v.colour === colour)) || null;

  return {
    node,
    selected,
    require() {
      if (selected()) return true;
      const row = (sizes.length && !size ? sizeRow : colourRow) || node;
      row.classList.remove('needs-pick');
      void row.offsetWidth;
      row.classList.add('needs-pick');
      toast(sizes.length && !size ? 'Pick a size first' : 'Pick a colour first');
      return false;
    }
  };
}

/* ---------------------------------------------------------- the shop page -- */
export async function shopScreen({ id, onOpen, onBack, onMessage }) {
  const s = await api.shop(id);
  if (!s) return el('<div class="screen"><div class="empty"><h2>This shop is closed</h2><p>It may have been suspended, or the link is wrong.</p></div></div>');

  const cover = s.cover_key
    ? `${window.NOVAMKT.SUPABASE_URL}/storage/v1/object/public/product-photos/${s.cover_key}-full.webp`
    : null;

  const root = el(`
    <div class="screen">
      <div class="scroll">
        <div class="shop-hero${cover ? ' has-cover' : ''}"${
          cover ? ` style="background-image:linear-gradient(rgba(14,70,54,.72),rgba(14,70,54,.88)),url('${esc(cover)}')"` : ''}>
          <button class="back" aria-label="Back" style="color:#fff;margin:0 0 6px -6px">${ICON.back}</button>
          <div class="shop-avatar">${esc(initials(s.brand_name))}</div>
          <h1>${esc(s.brand_name)}${s.founder ? '<span class="founder">Founder shop</span>' : ''}</h1>
          <div class="sub">${esc(s.city)} · since ${new Date(s.since).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}</div>
          <div class="shop-facts">
            <div><b>${s.live}</b><span>listings</span></div>
            <div><b>${s.delivered}</b><span>delivered</span></div>
            <div><b>${s.rating ? Number(s.rating).toFixed(1) : '—'}</b><span>${s.reviews} review${s.reviews === 1 ? '' : 's'}</span></div>
          </div>
        </div>
        <div id="story"></div>
        <div class="pad" style="padding:14px">
          <button class="btn ghost block" id="ask">Message this shop</button>
        </div>
        <div id="shop-reviews"></div>
        <div class="grid"></div>
      </div>
    </div>`);

  /* The story and the promise. A page with a name and a grid is a search
     result; a page with a story and a promise it has actually kept is a shop. */
  const story = root.querySelector('#story');
  if (s.story) {
    story.append(el(`<div class="shop-story"><p>${esc(s.story)}</p></div>`));
  }
  story.append(el(`
    <div class="promise">
      <div><b>${s.dispatch_days === 0 ? 'Same day' : `${s.dispatch_days} day${s.dispatch_days === 1 ? '' : 's'}`}</b><span>to post your parcel</span></div>
      ${s.on_time !== null && s.on_time !== undefined
        ? `<div><b>${s.on_time}%</b><span>arrived on time</span></div>`
        : '<div><b>New</b><span>not enough deliveries yet</span></div>'}
      <div><b>${s.delivered}</b><span>parcels delivered</span></div>
    </div>`));

  if ((s.latest_reviews || []).length) {
    const box = el(`<div class="group"><header><h2>What buyers said</h2><span class="note">${s.reviews}</span></header></div>`);
    for (const r of s.latest_reviews) {
      box.append(el(`
        <div class="review">
          <div class="who">${stars(r.rating)}<b>${esc(r.by)}</b>
            <span style="margin-left:auto;font-size:12.5px;color:var(--ink-faint)">${
              new Date(r.at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}</span></div>
          ${r.body ? `<p>${esc(r.body)}</p>` : ''}
          ${r.product ? `<p style="font-size:12.5px;color:var(--ink-faint)">on ${esc(r.product)}</p>` : ''}
        </div>`));
    }
    root.querySelector('#shop-reviews').append(box);
  }

  root.querySelector('.back').addEventListener('click', onBack);
  root.querySelector('#ask').addEventListener('click', () => onMessage(s.id, null));

  const grid = root.querySelector('.grid');
  const { tile } = await import('./views.js');
  if (!s.products.length) {
    grid.replaceWith(el('<div class="empty"><h2>Nothing listed yet</h2><p>This shop has not put anything up.</p></div>'));
  } else {
    for (const p of s.products) grid.append(tile(p, { onOpen }));
  }
  return root;
}

/* ------------------------------------------------------------- the offers -- */
export async function offersScreen({ onOpen }) {
  const items = await api.offers();
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Offers</h1></div>
      <div class="scroll"><div class="grid"></div></div>
    </div>`);
  const grid = root.querySelector('.grid');
  if (!items.length) {
    grid.replaceWith(el(`
      <div class="empty">
        <h2>No offers right now</h2>
        <p>When a shop puts something on sale it appears here first. Worth checking back.</p>
      </div>`));
    return root;
  }
  const { tile } = await import('./views.js');
  for (const p of items) grid.append(tile(p, { onOpen }));
  return root;
}

/* --------------------------------------------------------------- messages -- */
export async function inboxScreen({ onOpen }) {
  const threads = await api.msg.threads();
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Messages</h1></div>
      <div class="scroll"><div class="rows"></div></div>
    </div>`);
  const rows = root.querySelector('.rows');
  if (!threads.length) {
    rows.replaceWith(el(`
      <div class="empty">
        <h2>No messages yet</h2>
        <p>Ask a shop about a size, a colour, or how soon they can send it. Your questions live here.</p>
      </div>`));
    return root;
  }
  for (const t of threads) {
    const row = el(`
      <button class="line" style="grid-template-columns:44px 1fr auto;text-align:left;width:100%">
        <div class="ph" style="aspect-ratio:1;border-radius:12px;display:grid;place-items:center;background:var(--emerald-soft);color:var(--emerald-dark);font-weight:700">${esc(initials(t.seller))}</div>
        <div>
          <h3>${esc(t.seller)}</h3>
          <div class="sub">${t.from === 'seller' ? '' : 'You: '}${esc((t.preview || '').slice(0, 60))}</div>
          ${t.product ? `<div class="sub" style="color:var(--ink-faint)">about ${esc(t.product)}</div>` : ''}
        </div>
        ${t.unread ? '<span class="unread-dot" aria-label="unread"></span>' : ''}
      </button>`);
    row.addEventListener('click', () => onOpen(t.id));
    rows.append(row);
  }
  return root;
}

export async function threadScreen({ id, onBack }) {
  let data = await api.msg.thread(id);
  if (!data) return el('<div class="screen"><div class="empty"><h2>Conversation not found</h2><p>It may have been opened on another device.</p></div></div>');
  api.msg.read(id);

  const root = el(`
    <div class="screen">
      <div class="top">
        <button class="back" aria-label="Back">${ICON.back}</button>
        <h1 style="font-size:19px">${esc(data.seller)}</h1>
      </div>
      <div class="scroll"><div class="thread"></div></div>
      <form class="composer">
        <textarea placeholder="Write a message…" rows="1" aria-label="Your message"></textarea>
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`);
  root.querySelector('.back').addEventListener('click', onBack);

  const thread = root.querySelector('.thread');
  const scroll = root.querySelector('.scroll');
  const box = root.querySelector('textarea');

  const paint = () => {
    thread.replaceChildren();
    if (data.product) {
      thread.append(el(`<div class="notice info" style="margin:0 0 6px"><div>About <b>${esc(data.product)}</b></div></div>`));
    }
    for (const m of data.messages) {
      thread.append(el(`
        <div class="bubble ${esc(m.sender)}">${esc(m.body)}
          <span class="at">${new Date(m.at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })}</span>
        </div>`));
    }
    requestAnimationFrame(() => scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' }));
  };
  paint();

  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = Math.min(120, box.scrollHeight) + 'px';
  });

  root.querySelector('.composer').addEventListener('submit', async ev => {
    ev.preventDefault();
    const body = box.value.trim();
    if (!body) return;
    box.value = '';
    box.style.height = 'auto';
    // Show it immediately and reconcile — a message that waits for Seoul before
    // appearing feels broken on a slow connection.
    data.messages.push({ id: 'pending', sender: 'buyer', body, at: new Date().toISOString() });
    paint();
    try { data = await api.msg.send(id, body); paint(); }
    catch (err) { toast(err.message || 'Could not send that'); }
  });

  return root;
}

/* ---------------------------------------------------------------- reviews -- */
export function reviewSheet({ code, phone, items, onDone }) {
  const sheet = el(`
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Leave a review">
      <div class="sheet-in">
        <div class="sheet-bar">
          <h2>How was it?</h2>
          <button class="btn ghost" id="close" style="min-height:34px;padding:0 12px;font-size:13px">Close</button>
        </div>
        <div id="list"></div>
      </div>
    </div>`);
  const list = sheet.querySelector('#list');

  for (const item of items) {
    let rating = item.rating || 0;
    const card = el(`
      <div class="group">
        <header><h2>${esc(item.title)}</h2>${item.reviewed ? '<span class="note">reviewed</span>' : ''}</header>
        <div class="inner">
          <div class="star-pick"></div>
          <div class="field"><textarea placeholder="Anything worth telling the next buyer? Optional."></textarea></div>
          <button class="btn block" ${rating ? '' : 'disabled'}>${item.reviewed ? 'Update' : 'Send review'}</button>
        </div>
      </div>`);
    const pick = card.querySelector('.star-pick');
    const send = card.querySelector('button.btn');
    const paintStars = () => {
      pick.replaceChildren(...[1, 2, 3, 4, 5].map(i => {
        const b = el(`<button class="${i <= rating ? 'lit' : ''}" aria-label="${i} star${i === 1 ? '' : 's'}">${STAR}</button>`);
        b.addEventListener('click', () => { rating = i; send.disabled = false; paintStars(); pop(b); });
        return b;
      }));
    };
    paintStars();

    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        await api.leaveReview(code, phone, item.product_id, rating, card.querySelector('textarea').value.trim());
        burst(card, 8);
        toast('Thank you');
        item.reviewed = true;
        onDone?.();
        sheet.remove();
      } catch (err) {
        toast(err.message || 'Could not send that review');
        send.disabled = false;
        send.textContent = 'Send review';
      }
    });
    list.append(card);
  }

  const close = () => sheet.remove();
  sheet.querySelector('#close').addEventListener('click', close);
  sheet.addEventListener('click', ev => { if (ev.target === sheet) close(); });
  document.body.append(sheet);
}

/* Reviews under a listing. */
export async function reviewList(productId) {
  const rows = await api.reviews(productId);
  if (!rows.length) return null;
  const wrap = el(`<div class="group"><header><h2>What buyers said</h2><span class="note">${rows.length}</span></header></div>`);
  for (const r of rows) {
    wrap.append(el(`
      <div class="review">
        <div class="who">${stars(r.rating)}<b>${esc(r.by)}</b>
          <span style="margin-left:auto;font-size:12.5px;color:var(--ink-faint)">
            ${new Date(r.at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}</span></div>
        ${r.body ? `<p>${esc(r.body)}</p>` : ''}
      </div>`));
  }
  return wrap;
}

/* ---------------------------------------------------------------- account -- */
/* The buyer's own page: who they are, every order they have placed, and the way
   out. This is what the account is FOR — before it, a returning buyer had to
   remember a code and a phone number to find an order. */
export async function accountScreen({ onOrder, onSignedOut }) {
  const me = await api.meBuyer();
  if (!me) {
    return el(`
      <div class="screen"><div class="empty">
        <h2>No account yet</h2>
        <p>Fill a bag and check out — we make the account then, from what the order needs anyway.</p>
      </div></div>`);
  }

  const orders = await api.myOrders();
  const root = el(`
    <div class="screen">
      <div class="scroll">
        <div class="shop-hero">
          <div class="shop-avatar">${esc(initials(me.name))}</div>
          <h1>${esc(me.name)}</h1>
          <div class="sub">${esc(me.email)} · ${esc(me.phone)}</div>
          ${me.ref ? `<div class="ref-chip">Customer <b>#${esc(me.ref)}</b></div>` : ''}
          <div class="shop-facts">
            <div><b>${orders.length}</b><span>order${orders.length === 1 ? '' : 's'}</span></div>
            <div><b>${new Date(me.since).toLocaleDateString('en-PK', { month: 'short', year: 'numeric' })}</b><span>joined</span></div>
          </div>
        </div>
        <div id="orders"></div>
        <div class="pad" style="padding:16px 14px 26px">
          <button class="btn ghost block" id="out">Sign out</button>
        </div>
      </div>
    </div>`);

  const STATUS = { 1: ['Placed', 'placed'], 2: ['Confirmed', 'confirmed'],
                   3: ['On its way', 'dispatched'], 4: ['Delivered', 'delivered'],
                   5: ['Cancelled', 'refused'] };
  const box = root.querySelector('#orders');

  if (!orders.length) {
    box.append(el('<div class="empty"><h2>Nothing ordered yet</h2><p>Your orders will live here.</p></div>'));
  } else {
    const list = el('<div class="group"><header><h2>Your orders</h2></header></div>');
    for (const o of orders) {
      const [label, cls] = STATUS[o.status] || STATUS[1];
      const row = el(`
        <button class="line" style="grid-template-columns:56px 1fr auto;text-align:left;width:100%">
          <div class="ph">${o.cover
            ? `<img src="${esc(storage(o.cover))}" alt="" loading="lazy">`
            : ''}</div>
          <div>
            <h3>${esc(o.code)} <span class="state ${cls}">${label}</span></h3>
            <div class="sub">${esc((o.sellers || []).join(', '))}</div>
            <div class="sub" style="color:var(--ink-faint)">${
              new Date(o.placed_at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })
            } · ${o.units} item${o.units === 1 ? '' : 's'} · ${o.parcels} parcel${o.parcels === 1 ? '' : 's'}</div>
          </div>
          <div class="price num">${money(o.total)}</div>
        </button>`);
      row.addEventListener('click', () => onOrder(o.code));
      list.append(row);
    }
    box.append(list);
  }

  root.querySelector('#out').addEventListener('click', async () => {
    if (!confirm('Sign out? Your bag and saved items stay on this device.')) return;
    await account.signOut();
    onSignedOut();
  });
  return root;
}

const storage = key =>
  `${window.NOVAMKT.SUPABASE_URL}/storage/v1/object/public/product-photos/${key}-thumb.webp`;


/* --------------------------------------------------------- shop preview --- */
/* On a listing, below the description: who the shop is and three other things
   they make. A preview, not the shop — enough to decide whether to go and look,
   which is all it has to do. */
export async function shopPreview(sellerId, exceptId, onShop, onOpen) {
  const s = await api.shop(sellerId);
  if (!s) return null;
  const others = (s.products || []).filter(p => p.id !== exceptId).slice(0, 3);

  const box = el(`
    <div class="group shop-peek">
      <header><h2>From this shop</h2><button class="note link" id="all">See all ${s.live} →</button></header>
      <div class="peek-head">
        <div class="peek-avatar">${esc(initials(s.brand_name))}</div>
        <div>
          <b>${esc(s.brand_name)}${s.founder ? '<span class="founder">Founder</span>' : ''}</b>
          <span>${esc(s.city)} · ${s.delivered} delivered${
            s.rating ? ` · ${Number(s.rating).toFixed(1)}★` : ''}</span>
        </div>
      </div>
      ${s.story ? `<p class="peek-story">${esc(s.story.length > 160 ? s.story.slice(0, 158) + '…' : s.story)}</p>` : ''}
      <div class="peek-row"></div>
    </div>`);

  box.querySelector('#all').addEventListener('click', () => onShop(sellerId));
  const row = box.querySelector('.peek-row');
  if (!others.length) {
    row.remove();
  } else {
    for (const p of others) {
      const c = el(`
        <button class="peek-card">
          <div class="ph"><img src="${esc(p.photos[0])}" alt="" loading="lazy"></div>
          <b>${esc(p.title)}</b><span class="num">${money(p.price)}</span>
        </button>`);
      c.addEventListener('click', () => onOpen(p.id));
      row.append(c);
    }
  }
  return box;
}

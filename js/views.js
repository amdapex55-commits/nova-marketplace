/* Onboarding, browse, search, product and wishlist. */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON, money, toast } from './ui.js';
import { burst, pop, magnetToBag } from './motion.js';
import { priceHtml, variantPicker, stars, reviewList, policyStrip, shopPreview } from './shop.js';

/* --------------------------------------------------------------- onboarding */
/* Both steps are skippable, and the question is "who are you shopping for",
   not "what is your gender". A hard identity gate on the second screen, before
   anyone has seen a single product, is exactly where people leave — and the
   answer only ever weights ranking, so a skip costs the deck nothing. */
export function onboarding({ interests, onDone }) {
  let step = 0, gender = null, chosen = new Set();

  const root = el('<div class="screen"><div class="scroll"><div class="ob"></div></div></div>');
  const ob = root.querySelector('.ob');

  const render = () => {
    ob.replaceChildren();
    if (step === 0) {
      ob.append(el(`
        <div>
          <div class="step">Step 1 of 2</div>
          <h1>Who are you shopping for?</h1>
          <p class="sub">This only decides what we show first. You can change it any time, or skip it.</p>
        </div>`));
      const wrap = el('<div class="choices two"></div>');
      for (const [id, label] of [['women', 'Women'], ['men', 'Men'], ['everything', 'Show me everything'], ['skip', 'Skip for now']]) {
        const b = el(`<button class="choice" aria-pressed="false"${id === 'everything' || id === 'skip' ? ' style="grid-column:1/-1"' : ''}><b>${label}</b></button>`);
        b.addEventListener('click', () => { gender = id === 'skip' ? null : id; step = 1; render(); });
        wrap.append(b);
      }
      ob.append(wrap);
    } else {
      ob.append(el(`
        <div>
          <div class="step">Step 2 of 2</div>
          <h1>What are you into?</h1>
          <p class="sub">Pick as many as you like. Nothing gets hidden — your picks just come up sooner.</p>
        </div>`));
      const wrap = el('<div class="choices"></div>');
      for (const i of interests) {
        const b = el(`<button class="choice" aria-pressed="false"><b>${esc(i.label)}</b><span>${esc(i.hint)}</span></button>`);
        b.addEventListener('click', () => {
          chosen.has(i.id) ? chosen.delete(i.id) : chosen.add(i.id);
          b.setAttribute('aria-pressed', String(chosen.has(i.id)));
          go.textContent = chosen.size ? 'Start swiping' : 'Skip, show me everything';
        });
        wrap.append(b);
      }
      ob.append(wrap);
      const go = el('<button class="btn block" style="margin-top:20px">Skip, show me everything</button>');
      go.addEventListener('click', () => {
        store.setOnboarding({ gender, interests: [...chosen] });
        onDone();
      });
      ob.append(go);
      const back = el('<button class="btn ghost block" style="margin-top:10px">Back</button>');
      back.addEventListener('click', () => { step = 0; render(); });
      ob.append(back);
    }
  };
  render();
  return root;
}

/* --------------------------------------------------------------------- tiles */
export function tile(p, { onOpen }) {
  const node = el(`
    <article class="tile${p.promoted ? ' promoted' : ''}">
      <div class="ph">
        <img src="${esc(p.photos[0])}" alt="${esc(p.title)}" loading="lazy" decoding="async">
        ${p.was ? '<span class="sale-flag">Sale</span>' : p.promoted ? '<span class="promo-flag">Promoted</span>' : ''}
        <button class="heart" aria-pressed="${store.wished(p.id)}" aria-label="Save ${esc(p.title)} to wishlist">
          ${store.wished(p.id) ? ICON.heartOn : ICON.heart}
        </button>
      </div>
      <div class="body">
        <div class="brand">${esc(p.seller.brand_name)}</div>
        <h3>${esc(p.title)}</h3>
        ${(p.sizes || []).length ? `<div class="card-sizes">${p.sizes.slice(0,5).map(z => `<span>${esc(z)}</span>`).join('')}</div>` : ''}
        <div class="price">${priceHtml(p)}</div>
      </div>
    </article>`);
  node.querySelector('.ph img').addEventListener('click', () => onOpen(p.id));
  node.querySelector('.body').addEventListener('click', () => onOpen(p.id));
  const heart = node.querySelector('.heart');
  heart.addEventListener('click', ev => {
    ev.stopPropagation();
    const on = store.toggleWish(p.id);
    heart.setAttribute('aria-pressed', String(on));
    heart.innerHTML = on ? ICON.heartOn : ICON.heart;
    if (on) { burst(node.querySelector('.ph'), 8); pop(heart); }
    toast(on ? 'Saved to your wishlist' : 'Removed from your wishlist');
  });
  return node;
}

/* browse and search now live in browse.js — that screen grew banners, a
   two-level category tree, filters and suggestions, and had outgrown this
   file. tile() below is shared with it. */

/* ------------------------------------------------------------------ wishlist */
export async function wishlistScreen({ onOpen, onCheckout }) {
  const ids = store.get().wishlist;
  const items = await api.products(ids);
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Saved</h1></div>
      <div class="scroll"><div id="rows"></div></div>
    </div>`);
  const box = root.querySelector('#rows');

  if (!items.length) {
    box.append(el(`
      <div class="empty">
        <h2>Nothing saved yet</h2>
        <p>Swipe right on anything you like and it lands here. Nothing is bought until you check out.</p>
      </div>`));
    return root;
  }

  /* A row rather than a tile, because a saved item is one someone has already
     decided they like — what they need now is a price and a way to buy it, not
     another picture to admire. */
  for (const p of items) {
    const sized = (p.variants || []).length > 0;
    const row = el(`
      <div class="line saved-line">
        <div class="ph"><img src="${esc(p.photos[0])}" alt="" loading="lazy"></div>
        <div>
          <div class="brand">${esc(p.seller.brand_name)}</div>
          <h3>${esc(p.title)}</h3>
          <div class="sub">${p.stock > 0 ? `${p.stock} left` : 'Sold out'}${sized ? ' · pick a size on the listing' : ''}</div>
          <div class="saved-acts">
            <button class="btn quiet" data-act="bag" ${p.stock ? '' : 'disabled'}>Add to bag</button>
            <button class="btn" data-act="buy" ${p.stock ? '' : 'disabled'}>Buy it now</button>
          </div>
        </div>
        <div class="price">${priceHtml(p)}</div>
      </div>`);

    row.querySelector('.ph').addEventListener('click', () => onOpen(p.id));
    row.querySelector('h3').addEventListener('click', () => onOpen(p.id));

    const put = () => {
      // A listing with sizes cannot be bagged from here — the choice has to
      // happen somewhere, and guessing it for them is how the wrong size ships.
      if (sized) { onOpen(p.id); toast('Pick a size first'); return false; }
      store.addToBag(p.id);
      api.track('add_to_bag', p.id);
      return true;
    };
    row.querySelector('[data-act=bag]').addEventListener('click', ev => {
      if (put()) { pop(ev.currentTarget); toast('Added to your bag'); }
    });
    row.querySelector('[data-act=buy]').addEventListener('click', () => {
      if (put()) onCheckout();
    });
    box.append(row);
  }
  return root;
}

/* ------------------------------------------------------------------- product */
export async function productScreen({ id, onBack, onBag, onShop, onMessage, onOpen }) {
  const p = await api.product(id);
  if (!p) return el('<div class="screen"><div class="empty"><h2>This listing has gone</h2><p>It may have sold or been taken down.</p></div></div>');

  api.track('detail', p.id);
  const wished = store.wished(p.id);

  const root = el(`
    <div class="screen">
      <div class="scroll">
        <div class="top">
          <button class="back" aria-label="Back">${ICON.back}</button>
        </div>
        <div class="gallery">
          <div class="frames">${p.photos.map(src => `<img src="${esc(src)}" alt="${esc(p.title)}" decoding="async">`).join('')}</div>
          ${p.photos.length > 1 ? `<div class="dots">${p.photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
        </div>
        <div class="pdp">
          <div class="pdp-top">
            <div>
              <button class="brand shoplink" id="shop">${esc(p.seller.brand_name)}
                ${p.seller.rating ? `<span style="margin-left:6px">${stars(p.seller.rating, p.seller.reviews)}</span>` : ''}
              </button>
              <h1>${esc(p.title)}</h1>
            </div>
            <button class="icon-btn" id="share" aria-label="Share this listing">${ICON.share}</button>
          </div>
          <div class="price">${priceHtml(p)}</div>
          ${p.was && p.sale_ends_at ? `<div class="sale-until">Sale ends ${new Date(p.sale_ends_at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}</div>` : ''}
          <div id="picker" style="margin-top:18px"></div>
          <p class="desc">${esc(p.description)}</p>
          <dl class="facts">
            <div><dt>Condition</dt><dd>${esc(p.condition)}</dd></div>
            <div><dt>Ships from</dt><dd>${esc(p.city)}</dd></div>
            <div><dt>In stock</dt><dd>${p.stock > 0 ? `${p.stock} left` : 'Sold out'}</dd></div>
            <div><dt>Shop</dt><dd>${p.seller.delivered > 0
              ? `${p.seller.delivered} delivered`
              : 'New here'}</dd></div>
            <div style="grid-column:1/-1"><dt>Arrives in</dt><dd id="eta">about ${p.seller.dispatch_days + 2}–${p.seller.dispatch_days + 5} days</dd></div>
          </dl>
          <div class="pad" style="padding:14px 0 0">
            <button class="btn ghost block" id="ask-shop">Ask ${esc(p.seller.brand_name)} a question</button>
          </div>
          <div id="shoppreview"></div>
          <div id="policies"></div>
          <div id="reviews"></div>
          <div id="related"></div>
          <div class="fineprint">
            <a href="#/legal">How buying on Nova works</a>
            <button id="report">Report this listing</button>
          </div>
        </div>
      </div>
      <div class="sticky-buy">
        <button class="btn ghost" id="wish" aria-pressed="${wished}" aria-label="Save to wishlist">${wished ? ICON.heartOn : ICON.heart}</button>
        <button class="btn block" id="add" ${p.stock > 0 ? '' : 'disabled'}>${p.stock > 0 ? 'Add to bag' : 'Sold out'}</button>
      </div>
    </div>`);

  root.querySelector('.back').addEventListener('click', onBack);
  root.querySelector('#shop').addEventListener('click', () => onShop(p.seller.id));
  root.querySelector('#ask-shop').addEventListener('click', () => onMessage(p.seller.id, p.id));

  // Sizes and colours. A listing without them behaves exactly as before.
  const picker = variantPicker(p);
  root.querySelector('#picker').append(picker.node);

  // The delivery estimate is worked out from the buyer's own city once they
  // have given us one, and is a range rather than a promise.
  const city = store.get().contact?.city;
  if (city) {
    const same = city.trim().toLowerCase() === p.seller.city.trim().toLowerCase();
    const lo = p.seller.dispatch_days + 2;
    const hi = p.seller.dispatch_days + (same ? 2 : 5);
    root.querySelector('#eta').textContent = `${lo}–${hi} days to ${city}`;
  }

  root.querySelector('#policies').append(policyStrip());

  /* Share. The Web Share sheet where there is one — which on a phone is the
     WhatsApp forward this market actually runs on — and a copied link
     everywhere else. */
  root.querySelector('#share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#/p/${p.id}`;
    const text = `${p.title} — ${money(p.price)} from ${p.seller.brand_name} on Nova`;
    try {
      if (navigator.share) { await navigator.share({ title: p.title, text, url }); return; }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Link copied');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Could not share that');
    }
  });

  /* A preview of the shop, not the shop. Three of their other listings and the
     one line that says who they are — enough to decide whether to go and look,
     which is all this needs to do. */
  shopPreview(p.seller.id, p.id, onShop, onOpen)
    .then(node => { if (node) root.querySelector('#shoppreview').append(node); });

  api.related(p.id).then(items => {
    if (!items.length) return;
    const box = el('<div class="group"><header><h2>You might also like</h2></header><div class="rel"></div></div>');
    for (const r of items.slice(0, 6)) {
      const c = el(`
        <button class="rel-card">
          <div class="ph"><img src="${esc(r.photos[0])}" alt="" loading="lazy"></div>
          <b>${esc(r.title)}</b>
          <span class="num">${money(r.price)}</span>
        </button>`);
      c.addEventListener('click', () => onOpen(r.id));
      box.querySelector('.rel').append(c);
    }
    root.querySelector('#related').append(box);
  });

  reviewList(p.id).then(node => { if (node) root.querySelector('#reviews').append(node); });

  const dots = [...root.querySelectorAll('.dots i')];
  if (dots.length) {
    const frames = root.querySelector('.frames');
    frames.addEventListener('scroll', () => {
      const i = Math.round(frames.scrollLeft / frames.clientWidth);
      dots.forEach((d, n) => d.classList.toggle('on', n === i));
    }, { passive: true });
  }

  const wish = root.querySelector('#wish');
  wish.addEventListener('click', () => {
    const on = store.toggleWish(p.id);
    wish.setAttribute('aria-pressed', String(on));
    wish.innerHTML = on ? ICON.heartOn : ICON.heart;
    if (on) { burst(root.querySelector('.gallery'), 10); pop(wish); }
    toast(on ? 'Saved to your wishlist' : 'Removed from your wishlist');
  });

  root.querySelector('#add').addEventListener('click', () => {
    // A listing with sizes cannot go in the bag without one — the server
    // refuses it anyway, and finding that out at checkout is far too late.
    if (!picker.require()) return;
    const chosen = picker.selected();
    store.addToBag(p.id, 1, chosen ? { variant_id: chosen.id, label: [chosen.size, chosen.colour].filter(Boolean).join(' / ') } : null);
    api.track('add_to_bag', p.id);
    // The thumbnail flies to the bag before we navigate, so the count changing
    // is explained rather than just noticed. onBag() runs either way.
    magnetToBag(root.querySelector('.frames img'), {
      onArrive: () => { toast('Added to your bag'); onBag(); }
    });
  });

  root.querySelector('#report').addEventListener('click', () => reportSheet(p));

  return root;
}

/* ------------------------------------------------------------------- report */
/* Deliberately short. A form that asks for an essay gets no reports at all, and
   the reason alone is enough for someone to go and look at the listing. */
const REASONS = [
  ['counterfeit', 'Fake or counterfeit'],
  ['prohibited', 'Not allowed on Nova'],
  ['misleading', 'Photos or description are misleading'],
  ['offensive', 'Offensive or inappropriate'],
  ['scam', 'I think this is a scam'],
  ['other', 'Something else']
];

function reportSheet(product) {
  let reason = null;
  const sheet = el(`
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Report this listing">
      <div class="sheet-in">
        <div class="sheet-bar">
          <h2>Report this listing</h2>
          <button class="btn ghost" id="close" style="min-height:34px;padding:0 12px;font-size:13px">Close</button>
        </div>
        <div class="group" style="margin-top:14px">
          <div class="inner">
            <div role="radiogroup" aria-label="Reason" id="reasons" style="display:flex;flex-direction:column;gap:8px"></div>
            <div class="field">
              <label for="detail">Anything else? <span class="hint">optional</span></label>
              <textarea id="detail" maxlength="500" placeholder="What made you report it?"></textarea>
            </div>
            <button class="btn block" id="send" disabled>Send report</button>
            <div class="err" id="rerr" role="alert" hidden></div>
            <p style="font-size:12.5px;color:var(--ink-faint);margin:0">
              We read every report. Nothing is sent to the seller, and they are not told who reported them.
            </p>
          </div>
        </div>
      </div>
    </div>`);

  const list = sheet.querySelector('#reasons');
  const send = sheet.querySelector('#send');
  for (const [value, label] of REASONS) {
    const b = el(`<button class="opt" role="radio" aria-checked="false"><span class="mark"><i></i></span><span><b>${label}</b></span></button>`);
    b.addEventListener('click', () => {
      reason = value;
      for (const o of list.children) o.setAttribute('aria-checked', String(o === b));
      send.disabled = false;
    });
    list.append(b);
  }

  const close = () => sheet.remove();
  sheet.querySelector('#close').addEventListener('click', close);
  sheet.addEventListener('click', ev => { if (ev.target === sheet) close(); });

  send.addEventListener('click', async () => {
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const out = await api.reportListing(product.id, reason, sheet.querySelector('#detail').value.trim());
      toast(out?.already ? 'You have already reported this one' : 'Reported — thank you');
      close();
    } catch (err) {
      const e = sheet.querySelector('#rerr');
      e.hidden = false;
      e.textContent = err?.message || 'Could not send that report.';
      send.disabled = false;
      send.textContent = 'Send report';
    }
  });

  document.body.append(sheet);
}


/* ------------------------------------------------------------------- legal */
/* One screen rather than three separate pages. Nobody reads a wall of clauses,
   and the things that actually cause arguments here — who you are buying from,
   who holds the money, what happens at the door — fit on a page. Meta also
   wants terms and a privacy statement reachable before they will run ads. */
export function legalScreen({ onBack }) {
  const root = el(`
    <div class="screen">
      <div class="scroll">
        <div class="top">
          <button class="back" aria-label="Back">${ICON.back}</button>
          <h1>How Nova works</h1>
        </div>
        <div class="legal">
          <h2>Who you are buying from</h2>
          <p>Nova is a marketplace, not a shop. Every listing belongs to an
            independent seller who makes or sources it, packs it and sends it. We
            check each shop by hand before it can sell here, but the seller — not
            Nova — is who you are buying from.</p>

          <h2>Money</h2>
          <p><b>Nova never takes your money.</b> You pay the seller directly:
            cash to the rider when the parcel reaches you, or a transfer straight
            to the seller for larger orders. Nothing passes through us, and we
            never ask for card details.</p>
          <p>If anyone claiming to be from Nova asks you to send money to them,
            it is not us. Report the listing.</p>

          <h2>At the door</h2>
          <p>Open the parcel and check it before you pay the rider. If it is not
            what was listed you do not have to accept it, and refusing costs you
            nothing.</p>
          <p>An order with items from more than one seller arrives as separate
            parcels, possibly on different days, each paid for separately. Your
            order page shows where each one has got to.</p>

          <h2>Returns</h2>
          <p>Returns are between you and the seller, and each shop sets its own
            terms — ask before you order if it matters. Checking the parcel at
            the door is the protection that always works.</p>

          <h2>What may not be sold here</h2>
          <p>Counterfeit or replica goods · anything stolen · weapons and
            ammunition · drugs, alcohol, tobacco and vapes · medicines and
            supplements · live animals · currency, documents and identity papers
            · adult material · anything needing a licence to sell · anything
            illegal in Pakistan.</p>
          <p>Listings that break this are removed and the shop can be suspended.
            <b>Report anything you see</b> — the button is on every listing, and
            the seller is never told who reported them.</p>

          <h2>What we keep about you</h2>
          <p>You can browse, swipe and fill a bag with no account, and none of it
            leaves your phone: your interests, saved items and bag are stored in
            your own browser.</p>
          <p>When you place an order we keep what is needed to deliver it — your
            name, mobile number and address — and the sellers in that order see
            it so they can bring it to you. That is all. We do not sell it, we do
            not send marketing to it, and we do not track you across other sites.</p>
          <p>We count how many people see and save each listing so sellers know
            what is working. Those are totals, never a record of who did what.</p>

          <h2>Disagreements</h2>
          <p>Talk to the seller first — most problems are a wrong size or a slow
            week. If that goes nowhere, report the listing and we will look at it.
            We can remove listings and suspend shops; we cannot make a seller
            refund you, because we never held the money.</p>

          <p class="asof">Pakistan · last updated 4 September 2026</p>
        </div>
      </div>
    </div>`);
  root.querySelector('.back').addEventListener('click', onBack);
  root.querySelector('#shop').addEventListener('click', () => onShop(p.seller.id));
  root.querySelector('#ask-shop').addEventListener('click', () => onMessage(p.seller.id, p.id));

  // Sizes and colours. A listing without them behaves exactly as before.
  const picker = variantPicker(p);
  root.querySelector('#picker').append(picker.node);

  // The delivery estimate is worked out from the buyer's own city once they
  // have given us one, and is a range rather than a promise.
  const city = store.get().contact?.city;
  if (city) {
    const same = city.trim().toLowerCase() === p.seller.city.trim().toLowerCase();
    const lo = p.seller.dispatch_days + 2;
    const hi = p.seller.dispatch_days + (same ? 2 : 5);
    root.querySelector('#eta').textContent = `${lo}–${hi} days to ${city}`;
  }

  root.querySelector('#policies').append(policyStrip());

  /* Share. The Web Share sheet where there is one — which on a phone is the
     WhatsApp forward this market actually runs on — and a copied link
     everywhere else. */
  root.querySelector('#share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#/p/${p.id}`;
    const text = `${p.title} — ${money(p.price)} from ${p.seller.brand_name} on Nova`;
    try {
      if (navigator.share) { await navigator.share({ title: p.title, text, url }); return; }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Link copied');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Could not share that');
    }
  });

  /* A preview of the shop, not the shop. Three of their other listings and the
     one line that says who they are — enough to decide whether to go and look,
     which is all this needs to do. */
  shopPreview(p.seller.id, p.id, onShop, onOpen)
    .then(node => { if (node) root.querySelector('#shoppreview').append(node); });

  api.related(p.id).then(items => {
    if (!items.length) return;
    const box = el('<div class="group"><header><h2>You might also like</h2></header><div class="rel"></div></div>');
    for (const r of items.slice(0, 6)) {
      const c = el(`
        <button class="rel-card">
          <div class="ph"><img src="${esc(r.photos[0])}" alt="" loading="lazy"></div>
          <b>${esc(r.title)}</b>
          <span class="num">${money(r.price)}</span>
        </button>`);
      c.addEventListener('click', () => onOpen(r.id));
      box.querySelector('.rel').append(c);
    }
    root.querySelector('#related').append(box);
  });

  reviewList(p.id).then(node => { if (node) root.querySelector('#reviews').append(node); });
  return root;
}

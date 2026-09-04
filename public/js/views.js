/* Onboarding, browse, search, product and wishlist. */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON, money, toast } from './ui.js';

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
    <article class="tile">
      <div class="ph">
        <img src="${esc(p.photos[0])}" alt="${esc(p.title)}" loading="lazy" decoding="async">
        <button class="heart" aria-pressed="${store.wished(p.id)}" aria-label="Save ${esc(p.title)} to wishlist">
          ${store.wished(p.id) ? ICON.heartOn : ICON.heart}
        </button>
      </div>
      <div class="body">
        <div class="brand">${esc(p.seller.brand_name)}</div>
        <h3>${esc(p.title)}</h3>
        <div class="price num">${money(p.price)}</div>
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
    toast(on ? 'Saved to your wishlist' : 'Removed from your wishlist');
  });
  return node;
}

/* -------------------------------------------------------------------- browse */
export async function browseScreen({ onOpen }) {
  const { interests } = await api.meta();
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Browse</h1></div>
      <div class="chips" role="group" aria-label="Categories"></div>
      <div class="scroll"><div class="grid"></div></div>
    </div>`);
  const chips = root.querySelector('.chips');
  const grid = root.querySelector('.grid');
  let active = null;

  const load = async () => {
    grid.replaceChildren();
    const { items } = await api.browse({ interest: active });
    if (!items.length) grid.append(el('<p class="empty">Nothing here yet.</p>'));
    for (const p of items) grid.append(tile(p, { onOpen }));
  };

  const all = el('<button class="chip" aria-pressed="true">Everything</button>');
  chips.append(all);
  const buttons = [all];
  for (const i of interests) {
    const c = el(`<button class="chip" aria-pressed="false">${esc(i.label)}</button>`);
    buttons.push(c);
    chips.append(c);
    c.addEventListener('click', () => { active = i.id; buttons.forEach(b => b.setAttribute('aria-pressed', String(b === c))); load(); });
  }
  all.addEventListener('click', () => { active = null; buttons.forEach(b => b.setAttribute('aria-pressed', String(b === all))); load(); });

  load();
  return root;
}

/* -------------------------------------------------------------------- search */
export function searchScreen({ onOpen }) {
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Search</h1></div>
      <div class="searchbar">
        <label>
          ${ICON.search}
          <input type="search" placeholder="Kurta, chai, running, Lahore…" autocomplete="off" enterkeyhint="search" aria-label="Search products">
        </label>
      </div>
      <div class="scroll"><div class="grid"></div></div>
    </div>`);
  const input = root.querySelector('input');
  const grid = root.querySelector('.grid');

  let t;
  const run = async () => {
    const q = input.value.trim();
    grid.replaceChildren();
    if (!q) return;
    const { items } = await api.search(q);
    if (!items.length) {
      grid.append(el(`<p class="empty" style="grid-column:1/-1">No matches for “${esc(q)}”. Try a brand, a city, or a single word.</p>`));
      return;
    }
    for (const p of items) grid.append(tile(p, { onOpen }));
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 160); });
  setTimeout(() => input.focus({ preventScroll: true }), 60);
  return root;
}

/* ------------------------------------------------------------------ wishlist */
export async function wishlistScreen({ onOpen }) {
  const ids = store.get().wishlist;
  const items = await api.products(ids);
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Wishlist</h1></div>
      <div class="scroll"><div class="grid"></div></div>
    </div>`);
  const grid = root.querySelector('.grid');
  if (!items.length) {
    grid.replaceWith(el(`
      <div class="empty">
        <h2>Nothing saved yet</h2>
        <p>Swipe right on anything you like and it lands here. Nothing is bought until you check out.</p>
      </div>`));
    return root;
  }
  for (const p of items) grid.append(tile(p, { onOpen }));
  return root;
}

/* ------------------------------------------------------------------- product */
export async function productScreen({ id, onBack, onBag }) {
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
          <div class="brand">${esc(p.seller.brand_name)}</div>
          <h1>${esc(p.title)}</h1>
          <div class="price num">${money(p.price)}</div>
          <p class="desc">${esc(p.description)}</p>
          <dl class="facts">
            <div><dt>Condition</dt><dd>${esc(p.condition)}</dd></div>
            <div><dt>Ships from</dt><dd>${esc(p.city)}</dd></div>
            <div><dt>In stock</dt><dd>${p.stock > 0 ? `${p.stock} left` : 'Sold out'}</dd></div>
            <div><dt>Seller rating</dt><dd>${esc(p.seller.rating)} / 5</dd></div>
          </dl>
        </div>
      </div>
      <div class="sticky-buy">
        <button class="btn ghost" id="wish" aria-pressed="${wished}" aria-label="Save to wishlist">${wished ? ICON.heartOn : ICON.heart}</button>
        <button class="btn block" id="add" ${p.stock > 0 ? '' : 'disabled'}>${p.stock > 0 ? 'Add to bag' : 'Sold out'}</button>
      </div>
    </div>`);

  root.querySelector('.back').addEventListener('click', onBack);

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
    toast(on ? 'Saved to your wishlist' : 'Removed from your wishlist');
  });

  root.querySelector('#add').addEventListener('click', () => {
    store.addToBag(p.id);
    api.track('add_to_bag', p.id);
    toast('Added to your bag');
    onBag();
  });

  return root;
}

/* Browse and search.
 *
 * Lifted out of views.js when browse stopped being "a grid with four chips":
 * it now carries banners, a two-level category tree, filters, and a search box
 * with suggestions. That is a screen in its own right.
 */
import { api } from './api.js';
import { el, esc, ICON, toast } from './ui.js';
import { tile } from './views.js';

/* ------------------------------------------------------------------ banners */
/* Merchandising, from rows in a table. Horizontal because a stack of banners is
   a page nobody scrolls past — one at a time, swipeable, and the rest are
   discoverable rather than shouted. */
function bannerRail(banners, onGo) {
  if (!banners.length) return null;
  const rail = el('<div class="banners"></div>');
  for (const b of banners) {
    const card = el(`
      <button class="banner tone-${esc(b.tone)}">
        <b>${esc(b.headline)}</b>
        ${b.sub ? `<span>${esc(b.sub)}</span>` : ''}
        <i>${esc(b.cta)} →</i>
      </button>`);
    card.addEventListener('click', () => { api.site('banner_click', b.headline); onGo(b.target); });
    rail.append(card);
  }
  return rail;
}

/* -------------------------------------------------------------- categories */
/* Two levels, and the second only appears once a group is picked. Showing
   thirty leaves at once is a directory; showing eight groups is a shop. */
function categoryRail({ tree, group, leaf, onGroup, onLeaf }) {
  const wrap = el('<div class="cats"></div>');

  const top = el('<div class="chips" role="group" aria-label="Categories"></div>');
  const all = el(`<button class="chip" aria-pressed="${!group}">Everything</button>`);
  all.addEventListener('click', () => onGroup(null));
  top.append(all);
  for (const g of tree) {
    if (!g.live) continue;                       // never offer an empty group
    const c = el(`<button class="chip" aria-pressed="${group === g.slug}">${
      g.emoji ? `<span class="cat-emoji">${g.emoji}</span>` : ''}${esc(g.label)}</button>`);
    c.addEventListener('click', () => { api.site('category_used', g.slug); onGroup(group === g.slug ? null : g.slug); });
    top.append(c);
  }
  wrap.append(top);

  const chosen = tree.find(g => g.slug === group);
  if (chosen) {
    const sub = el('<div class="chips subcats" role="group" aria-label="Sub-categories"></div>');
    const any = el(`<button class="chip small" aria-pressed="${!leaf}">All ${esc(chosen.label.toLowerCase())}</button>`);
    any.addEventListener('click', () => onLeaf(null));
    sub.append(any);
    for (const c of chosen.children) {
      if (!c.live) continue;
      const b = el(`<button class="chip small" aria-pressed="${leaf === c.slug}">${esc(c.label)}<span class="cat-n">${c.live}</span></button>`);
      b.addEventListener('click', () => { api.site('category_used', c.slug); onLeaf(leaf === c.slug ? null : c.slug); });
      sub.append(b);
    }
    wrap.append(sub);
  }
  return wrap;
}

/* ------------------------------------------------------------------ browse */
export async function browseScreen({ onOpen, onSearch }) {
  const [tree, banners] = await Promise.all([api.categories(), api.banners()]);

  let group = null, leaf = null;
  let filters = { sort: 'new' };
  let facets = { sizes: [], cities: [], max_price: 0 };
  let offset = 0, total = 0, loading = false;

  const root = el(`
    <div class="screen">
      <div class="top"><h1>Browse</h1></div>
      <div class="searchbar">
        <button class="fake-search">
          ${ICON.search}<span>Search everything</span>
        </button>
      </div>
      <div id="banners"></div>
      <div id="cats"></div>
      <div class="filter-bar" role="group" aria-label="Filters"></div>
      <div class="result-count" id="count"></div>
      <div class="scroll"><div class="grid"></div><div id="more"></div></div>
    </div>`);

  root.querySelector('.fake-search').addEventListener('click', onSearch);

  const go = target => {
    if (target.startsWith('#/')) { location.hash = target; return; }
    const g = tree.find(t => t.slug === target);
    if (g) { group = target; leaf = null; }
    else { group = tree.find(t => t.children.some(c => c.slug === target))?.slug || null; leaf = target; }
    paintCats(); load();
  };

  const rail = bannerRail(banners, go);
  if (rail) root.querySelector('#banners').append(rail);

  const catBox = root.querySelector('#cats');
  const paintCats = () => {
    catBox.replaceChildren(categoryRail({
      tree, group, leaf,
      onGroup: g => { group = g; leaf = null; paintCats(); load(); },
      onLeaf: l => { leaf = l; paintCats(); load(); }
    }));
  };
  paintCats();

  const grid = root.querySelector('.grid');
  const bar = root.querySelector('.filter-bar');
  const count = root.querySelector('#count');
  const more = root.querySelector('#more');

  const activeCount = () =>
    ['min', 'max', 'city', 'size', 'condition'].filter(k => filters[k]).length + (filters.onSale ? 1 : 0);

  const drawFilters = () => {
    bar.replaceChildren();
    const pill = (label, on, fn) => {
      const b = el(`<button class="filter-pill" data-on="${on}">${label}</button>`);
      b.addEventListener('click', fn);
      bar.append(b);
    };
    pill(`Filters${activeCount() ? `<span class="filter-count">${activeCount()}</span>` : ''}`,
      activeCount() > 0, filterSheet);
    pill('On sale', !!filters.onSale, () => { filters.onSale = !filters.onSale; api.site('filter_used', 'on_sale'); load(); });
    pill(filters.sort === 'cheap' ? 'Cheapest' : filters.sort === 'dear' ? 'Dearest' : 'Newest',
      filters.sort !== 'new', () => {
        filters.sort = filters.sort === 'new' ? 'cheap' : filters.sort === 'cheap' ? 'dear' : 'new';
        load();
      });
    for (const z of (facets.sizes || []).slice(0, 6)) {
      pill(z, filters.size === z, () => { filters.size = filters.size === z ? null : z; load(); });
    }
  };

  const filterSheet = () => {
    const sheet = el(`
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Filters">
        <div class="sheet-in">
          <div class="sheet-bar"><h2>Filters</h2>
            <button class="btn ghost" id="clear" style="min-height:34px;padding:0 12px;font-size:13px">Clear all</button>
          </div>
          <div class="group"><div class="inner">
            <div class="two-up">
              <div class="field"><label for="fmin">Least</label><input id="fmin" type="number" inputmode="numeric" placeholder="Rs 0" value="${filters.min ?? ''}"></div>
              <div class="field"><label for="fmax">Most</label><input id="fmax" type="number" inputmode="numeric" placeholder="${facets.max_price ? 'Rs ' + facets.max_price : 'any'}" value="${filters.max ?? ''}"></div>
            </div>
            <div class="field"><label for="fcity">City</label><select id="fcity"><option value="">Anywhere</option>${
              (facets.cities || []).map(c => `<option${filters.city === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
            <div class="field"><label for="fcond">Condition</label><select id="fcond"><option value="">Any</option>${
              ['New', 'Like new', 'Gently used'].map(c => `<option${filters.condition === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
            <button class="btn block" id="apply">Show results</button>
          </div></div>
        </div>
      </div>`);
    const close = () => sheet.remove();
    sheet.addEventListener('click', ev => { if (ev.target === sheet) close(); });
    sheet.querySelector('#clear').addEventListener('click', () => { filters = { sort: filters.sort }; close(); load(); });
    sheet.querySelector('#apply').addEventListener('click', () => {
      filters.min = Number(sheet.querySelector('#fmin').value) || null;
      filters.max = Number(sheet.querySelector('#fmax').value) || null;
      filters.city = sheet.querySelector('#fcity').value || null;
      filters.condition = sheet.querySelector('#fcond').value || null;
      close(); load();
    });
    document.body.append(sheet);
  };

  /* Paged rather than one enormous fetch: a category with four hundred items
     should not cost four hundred rows to look at the first six. */
  async function load(append = false) {
    if (loading) return;
    loading = true;
    if (!append) { offset = 0; grid.replaceChildren(); count.textContent = 'Looking…'; }
    const res = await api.browse({
      interest: leaf ? null : group, limit: 24, offset,
      filters: { ...filters, category: leaf }
    });
    if (res.facets) facets = res.facets;
    total = res.total ?? res.items.length;
    drawFilters();
    count.textContent = `${total} ${total === 1 ? 'listing' : 'listings'}`;
    if (!res.items.length && !append) {
      grid.append(el(`
        <div class="empty" style="grid-column:1/-1">
          <h2>Nothing matches</h2>
          <p>Try fewer filters, or a different category.</p>
        </div>`));
    }
    for (const p of res.items) grid.append(tile(p, { onOpen }));
    offset += res.items.length;
    loading = false;
    drawMore();
  }

  function drawMore() {
    more.replaceChildren();
    if (offset >= total) return;
    const b = el(`<div class="pad" style="padding-bottom:22px"><button class="btn ghost block">Show more (${total - offset} left)</button></div>`);
    b.querySelector('button').addEventListener('click', ev => {
      ev.currentTarget.textContent = 'Loading…';
      load(true);
    });
    more.append(b);
  }

  load();
  return root;
}

/* ------------------------------------------------------------------ search */
export function searchScreen({ onOpen }) {
  const root = el(`
    <div class="screen">
      <div class="top">
        <button class="back" aria-label="Back">${ICON.back}</button>
        <h1 style="font-size:22px">Search</h1>
      </div>
      <div class="searchbar">
        <label>
          ${ICON.search}
          <input type="search" placeholder="Kurta, chai, Lahore, a shop name…" autocomplete="off" enterkeyhint="search" aria-label="Search products">
          <button class="clear-q" aria-label="Clear" hidden>${ICON.x}</button>
        </label>
      </div>
      <div id="suggest"></div>
      <div class="scroll"><div class="grid"></div></div>
    </div>`);

  const input = root.querySelector('input');
  const grid = root.querySelector('.grid');
  const suggest = root.querySelector('#suggest');
  const clear = root.querySelector('.clear-q');
  root.querySelector('.back').addEventListener('click', () => history.back());

  const chipRow = (title, words) => {
    if (!words?.length) return null;
    const box = el(`<div class="suggest-block"><h3>${esc(title)}</h3><div class="chips"></div></div>`);
    for (const w of words) {
      const c = el(`<button class="chip">${esc(w)}</button>`);
      c.addEventListener('click', () => { input.value = w; run(); });
      box.querySelector('.chips').append(c);
    }
    return box;
  };

  /* Loaded before a single keystroke, so an empty search box is a starting
     point rather than a blank wall. Everything offered is built from what is
     actually in the catalogue, so a suggestion can never return nothing. */
  const paintIdle = async () => {
    const s = await api.suggestions();
    suggest.replaceChildren();
    const pop = chipRow('Browse by', s.popular);
    const tr = chipRow('People are searching', s.trending);
    if (pop) suggest.append(pop);
    if (tr) suggest.append(tr);
    if (!pop && !tr) suggest.append(el('<p class="suggest-none">Type anything — a product, a shop, a city.</p>'));
  };
  paintIdle();

  let t;
  const run = async () => {
    const q = input.value.trim();
    clear.hidden = !q;
    grid.replaceChildren();
    if (!q) { paintIdle(); return; }

    // While typing, offer completions rather than results for a half-word.
    if (q.length < 3) {
      const s = await api.suggestions(q);
      suggest.replaceChildren();
      const m = chipRow('Did you mean', s.matches);
      if (m) suggest.append(m);
      return;
    }

    suggest.replaceChildren();
    const { items } = await api.search(q);
    api.recordSearch(q, items.length);
    api.site(items.length ? 'search_ok' : 'search_empty', q);
    if (!items.length) {
      grid.append(el(`
        <div class="empty" style="grid-column:1/-1">
          <h2>No matches for “${esc(q)}”</h2>
          <p>Try a single word, a brand, or a city.</p>
        </div>`));
      const s = await api.suggestions();
      const pop = chipRow('Try one of these', s.popular);
      if (pop) suggest.append(pop);
      return;
    }
    for (const p of items) grid.append(tile(p, { onOpen }));
  };

  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 180); });
  clear.addEventListener('click', () => { input.value = ''; input.focus(); run(); });
  setTimeout(() => input.focus({ preventScroll: true }), 60);
  return root;
}

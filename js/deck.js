/* The swipe deck.
 *
 * Constraints this file exists to honour, in order:
 *   1. The first card must be on screen when the splash lifts.
 *   2. Three cards are mounted. Never the whole page.
 *   3. Only transform and opacity animate — no layout, no paint of the photo.
 *   4. Every swipe is undoable.
 *   5. Nothing already seen comes back, on this visit or the next one.
 */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON, money, toast } from './ui.js';
import { burst, pop, parallax, resetParallax, ghostDeck } from './motion.js';
import { priceHtml } from './shop.js';

const THROW = 0.26;      // fraction of card width that counts as a decision
const FLICK = 0.55;      // px/ms — a fast flick decides even if it is short
const PRELOAD = 8;

export function deckScreen({ onOpen }) {
  /* Three decks, one gesture.
     They are separate queues rather than a filter on one, because switching
     back should land you where you left off rather than at the top of a
     reshuffled pile. */
  const FEEDS = [
    { id: 'you', label: 'For you', empty: 'You have seen everything that matches you.' },
    { id: 'offers', label: 'Offers', empty: 'No sales running right now.' },
    { id: 'trending', label: 'Trending', empty: 'Nothing is moving yet — be the first.' }
  ];
  let feed = 'you';

  const root = el(`
    <div class="screen">
      <div class="deck-wrap">
        <div class="capsules" role="tablist" aria-label="What to swipe"></div>
        <div class="deck-head">
          <h1 class="display" id="deck-title">For you</h1>
          <span class="count" id="deck-count"></span>
        </div>
        <div class="deck" id="deck"></div>
        <div class="deck-actions">
          <button class="round small" id="undo" aria-label="Bring back the last one" disabled>${ICON.undo}</button>
          <button class="round pass" id="pass" aria-label="Pass">${ICON.x}</button>
          <button class="round keep" id="keep" aria-label="Save to wishlist">${ICON.heart}</button>
        </div>
      </div>
    </div>`);

  const deck = root.querySelector('#deck');
  const countEl = root.querySelector('#deck-count');
  const undoBtn = root.querySelector('#undo');

  // One of these per capsule, so switching keeps your place in each.
  const decks = Object.fromEntries(FEEDS.map(f =>
    [f.id, { queue: [], history: [], offset: 0, remaining: 0, loaded: false }]));
  let loading = false;
  let busy = false;        // a card is mid-flight
  // One automatic loop per visit. Twice would be a carousel nobody can leave.
  let looped = false;

  const D = () => decks[feed];

  /* ---------- data ---------- */

  async function fill() {
    if (loading) return;
    loading = true;
    const d = D();
    const forFeed = feed;
    try {
      let items = [], remaining = 0;
      if (forFeed === 'you') {
        const page = await api.deck({ offset: d.offset });
        items = page.items; remaining = page.remaining;
      } else if (forFeed === 'offers') {
        items = d.loaded ? [] : await api.offers();
      } else {
        items = d.loaded ? [] : await api.trending();
      }
      d.loaded = true;

      // The ledger is written when a card is decided, but a page is requested
      // before that, so filter again here — otherwise a fast swiper can be
      // handed a card they just dismissed. Offers and Trending are short lists
      // people come back to, so being seen does not remove them from those.
      const fresh = forFeed === 'you'
        ? items.filter(p => !store.hasSeen(p.id) && !d.queue.some(q => q.id === p.id))
        : items.filter(p => !d.queue.some(q => q.id === p.id));
      d.queue.push(...fresh);
      d.offset += items.length;
      d.remaining = remaining;
    } finally {
      loading = false;
    }
    if (forFeed === feed) render();
  }

  const preload = () => {
    for (const p of D().queue.slice(1, 1 + PRELOAD)) {
      if (p._pre) continue;
      p._pre = true;
      const img = new Image();
      img.decoding = 'async';
      img.src = p.photos[0];
    }
  };

  /* ---------- rendering ---------- */

  function card(p, depth) {
    const node = el(`
      <article class="swipe-card${p.promoted ? ' promoted' : ''}" style="transform:${rest(depth)};z-index:${10 - depth}" data-id="${esc(p.id)}">
        <div class="photo">
          <img src="${esc(p.photos[0])}" alt="${esc(p.title)}" ${depth === 0 ? 'fetchpriority="high"' : ''} decoding="async">
          ${p.was ? '<span class="sale-flag">Sale</span>' : p.promoted ? '<span class="promo-flag">Promoted</span>' : ''}
          <div class="stamp keep">Saved</div>
          <div class="stamp pass">Pass</div>
        </div>
        <div class="meta">
          <div class="brand">${esc(p.seller.brand_name)}</div>
          <h2>${esc(p.title)}</h2>
          <div class="row">
            <span class="price">${priceHtml(p)}</span>
            <span class="where">${esc(p.city)} · ${esc(p.condition)}</span>
          </div>
          ${(p.sizes || []).length ? `<div class="card-sizes">${p.sizes.map(z => `<span>${esc(z)}</span>`).join('')}</div>` : ''}
        </div>
      </article>`);
    if (depth === 0) {
      attach(node, p);
      // Tapping the photo opens the full listing — swiping is discovery, the
      // detail page is where a decision to buy is actually made.
      node.querySelector('.photo').addEventListener('click', ev => {
        if (node._dragged) { ev.preventDefault(); return; }
        onOpen(p.id);
      });
    }
    return node;
  }

  const rest = depth => `translate3d(0,${depth * 9}px,0) scale(${1 - depth * 0.035})`;

  let revealed = false;

  function render() {
    deck.replaceChildren();

    // Waiting on a page rather than out of products: show skeletons instead of
    // the end-of-deck screen, or a slow network reads as "you've seen it all".
    if (!D().queue.length && (loading || D().remaining > 0)) {
      deck.append(ghostDeck());
      countEl.textContent = '';
      return;
    }

    /* Out of cards on "For you"? Start the deck again rather than stopping to
       ask. A deck that ends is a deck someone closes; a deck that loops is one
       they keep swiping — and everything they have already decided on is still
       remembered, so the second pass is a second look, not a reset. */
    if (!D().queue.length && feed === 'you' && !loading && store.get().seen.length > 0 && !looped) {
      looped = true;
      store.resetSeen();
      Object.values(decks).forEach(d => { d.queue = []; d.offset = 0; d.loaded = false; });
      deck.replaceChildren(ghostDeck('Bringing them back around…'));
      countEl.textContent = '';
      fill();
      return;
    }

    if (!D().queue.length) {
      const meta = FEEDS.find(f => f.id === feed);
      deck.append(el(`
        <div class="deck-empty">
          <h2>That's everything, for now</h2>
          <p>${esc(meta.empty)}${feed === 'you' ? ' New products arrive daily.' : ''}</p>
          ${feed === 'you' ? '<button class="btn quiet" id="reset-seen">Start the deck again</button>' : ''}
        </div>`));
      deck.querySelector('#reset-seen')?.addEventListener('click', () => {
        store.resetSeen();
        Object.values(decks).forEach(d => { d.queue = []; d.history = []; d.offset = 0; d.loaded = false; });
        fill();
      });
      countEl.textContent = '';
      return;
    }
    // Back to front, so the top card is the last child and needs no z-index war.
    const q = D().queue;
    for (let d = Math.min(2, q.length - 1); d >= 0; d--) deck.append(card(q[d], d));

    // Once, on the first deck of the session — a card that re-enters on every
    // render reads as a bug rather than a flourish.
    if (!revealed) {
      revealed = true;
      deck.classList.add('first-reveal');
      setTimeout(() => deck.classList.remove('first-reveal'), 700);
    }

    countEl.textContent = `${D().queue.length + D().remaining} left`;
    api.track('impression', q[0].id);
    maybeCoach();
    preload();
  }

  /* ---------- gesture ---------- */

  function attach(node, product) {
    let startX = 0, startY = 0, startT = 0, dx = 0, dy = 0, dragging = false, id = null;
    const keep = node.querySelector('.stamp.keep');
    const pass = node.querySelector('.stamp.pass');

    const down = ev => {
      if (busy || ev.button > 0) return;
      dragging = true; id = ev.pointerId;
      startX = ev.clientX; startY = ev.clientY; startT = performance.now();
      node._dragged = false;
      node.classList.remove('settling');
      node.setPointerCapture(id);
    };

    /* One transform per animation frame, never per pointer event.
       A finger produces far more pointermove events than the screen has frames,
       and writing a transform for each one is work the compositor throws away —
       it is what made the drag feel busy rather than smooth. */
    let frame = 0, pending = null;
    const apply = () => {
      frame = 0;
      if (!pending) return;
      const { x, y } = pending;
      const t = x / node.offsetWidth;
      // Vertical movement is damped and capped: a swipe is a horizontal
      // decision, and letting the card wander up and down makes it feel loose.
      const lift = Math.max(-46, Math.min(46, y * 0.28));
      // Rotation eases off at the extremes rather than growing without limit,
      // so a long drag looks intentional instead of spun.
      const turn = Math.tanh(t * 1.6) * 13;
      node.style.transform =
        `translate3d(${x.toFixed(1)}px, ${lift.toFixed(1)}px, 0) rotate(${turn.toFixed(2)}deg)`;
      parallax(deck, t / THROW);
      keep.style.opacity = Math.max(0, Math.min(1, t / THROW));
      pass.style.opacity = Math.max(0, Math.min(1, -t / THROW));
    };

    const move = ev => {
      if (!dragging || ev.pointerId !== id) return;
      dx = ev.clientX - startX;
      dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) node._dragged = true;
      pending = { x: dx, y: dy };
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const up = ev => {
      if (!dragging || ev.pointerId !== id) return;
      dragging = false;
      node.releasePointerCapture(id);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      const t = dx / node.offsetWidth;
      const v = Math.abs(dx) / Math.max(1, performance.now() - startT);
      if (Math.abs(t) > THROW || (v > FLICK && Math.abs(dx) > 30)) {
        // Carry the flick's speed into the exit so a hard throw leaves faster
        // than a slow drag does. That single detail is most of what makes it
        // feel like an object rather than an animation.
        fly(node, product, dx > 0 ? 1 : -1, v);
      } else {
        node.classList.add('settling');
        node.style.transform = rest(0);
        keep.style.opacity = pass.style.opacity = 0;
        resetParallax(deck);
      }
      dx = dy = 0;
    };

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  /* ---------- decisions ---------- */

  function fly(node, product, dir, velocity = 0) {
    if (busy || !node?.classList.contains('swipe-card') || !product) return;
    busy = true;
    // A fast flick leaves in ~170ms, a deliberate push in ~300ms.
    const ms = Math.round(Math.max(170, Math.min(300, 300 - velocity * 140)));
    node.style.transition = `transform ${ms}ms cubic-bezier(.32,.72,.28,1), opacity ${ms}ms ease`;
    node.style.transform = `translate3d(${dir * (innerWidth + 240)}px, -50px, 0) rotate(${dir * 24}deg)`;
    node.style.opacity = '0';
    node.querySelector(dir > 0 ? '.stamp.keep' : '.stamp.pass').style.opacity = '1';
    setTimeout(() => { commit(product, dir); busy = false; }, ms - 40);
  }

  function commit(product, dir) {
    const d = D();
    d.queue = d.queue.filter(p => p.id !== product.id);
    store.markSeen(product.id);
    d.history.push({ product, dir, wished: false });
    let saved = false;
    if (dir > 0 && !store.wished(product.id)) {
      store.toggleWish(product.id);
      d.history.at(-1).wished = true;
      saved = true;
      toast('Saved to your wishlist');
    }
    if (!store.get().swiped_once) store.markSwiped();
    root.dispatchEvent(new CustomEvent('deck:decided'));
    api.track(dir > 0 ? 'keep' : 'pass', product.id);
    undoBtn.disabled = false;
    if (d.queue.length <= 10 && d.remaining > 0) fill();
    render();

    // After render(), not before: render() calls deck.replaceChildren(), which
    // would take the burst layer straight back out again.
    if (saved) {
      burst(deck);
      pop(root.querySelector('.round.keep'));
    }
  }

  function decide(dir) {
    // The deck's last child is not always a card: it is the ghost stack while a
    // page is loading, and the end-of-deck panel when there is nothing left.
    // Pressing pass or save then reached fly(), which looks for a `.stamp` that
    // does not exist and crashed on null. Ask for a real card.
    const top = deck.querySelector('.swipe-card:last-of-type');
    if (!top || !D().queue.length || busy) return;
    fly(top, D().queue[0], dir);
  }

  function undo() {
    const last = D().history.pop();
    if (!last) return;
    store.unsee(last.product.id);
    // Only unwish what the swipe itself added — a product the buyer had already
    // saved from the grid must survive an undo here.
    if (last.wished) store.toggleWish(last.product.id);
    D().queue.unshift(last.product);
    undoBtn.disabled = D().history.length === 0;
    render();
  }

  root.querySelector('#pass').addEventListener('click', () => decide(-1));
  root.querySelector('#keep').addEventListener('click', () => decide(1));
  undoBtn.addEventListener('click', undo);

  // Arrow keys make the deck operable without a pointer, and make it far
  // quicker to test by hand.
  const keys = ev => {
    if (ev.key === 'ArrowLeft') decide(-1);
    else if (ev.key === 'ArrowRight') decide(1);
    else if (ev.key === 'z' && (ev.metaKey || ev.ctrlKey)) undo();
  };
  addEventListener('keydown', keys);
  root.addEventListener('screen:leave', () => removeEventListener('keydown', keys));

  // fill() sets `loading` synchronously and resolves later, so rendering right
  // after it — without awaiting — paints the ghost cards for exactly as long as
  // the first page takes. Awaiting here instead meant the deck simply appeared,
  // and a slow connection showed an empty frame with no explanation.
  /* The capsules. Switching is instant on a deck already loaded, because each
     keeps its own queue — going back to "For you" lands where you left off. */
  const caps = root.querySelector('.capsules');
  const drawCapsules = () => {
    caps.replaceChildren(...FEEDS.map(f => {
      const b = el(`<button class="capsule" role="tab" aria-selected="${f.id === feed}">${esc(f.label)}</button>`);
      b.addEventListener('click', () => {
        if (feed === f.id) return;
        feed = f.id;
        root.querySelector('#deck-title').textContent = f.label;
        drawCapsules();
        deck.classList.add('feed-swap');
        setTimeout(() => deck.classList.remove('feed-swap'), 420);
        undoBtn.disabled = D().history.length === 0;
        if (!D().loaded) { render(); fill(); } else render();
      });
      return b;
    }));
  };
  drawCapsules();

  /* Shown once, over the first card, until the first swipe. A deck nobody
     realises is swipeable is a grid with one item in it.

     Called from render(), not once at construction: render() replaces the
     deck's children whenever a page arrives, so a coach appended beforehand was
     wiped a moment later and never seen. */
  function maybeCoach() {
    if (store.get().swiped_once || deck.querySelector('.coach')) return;
    const coach = el(`
      <div class="coach" aria-hidden="true">
        <div class="coach-hand"></div>
        <div class="coach-words">
          <b>Swipe to decide</b>
          <span><i class="l"></i> not for me &nbsp;·&nbsp; save it <i class="r"></i></span>
        </div>
      </div>`);
    deck.append(coach);
    const clear = () => {
      if (!coach.isConnected) return;
      coach.classList.add('gone');
      setTimeout(() => coach.remove(), 320);
    };
    // No timer. It goes when they touch the card or make a decision — a hint
    // that disappears on its own after six seconds is one the person who needed
    // it most never finished reading.
    root.addEventListener('deck:decided', clear, { once: true });
    deck.addEventListener('pointerdown', clear, { once: true });
  }

  fill();
  render();
  return root;
}

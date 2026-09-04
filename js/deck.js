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

const THROW = 0.26;      // fraction of card width that counts as a decision
const FLICK = 0.55;      // px/ms — a fast flick decides even if it is short
const PRELOAD = 8;

export function deckScreen({ onOpen }) {
  const root = el(`
    <div class="screen">
      <div class="deck-wrap">
        <div class="deck-head">
          <h1 class="display">For you</h1>
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

  let queue = [];          // upcoming products, index 0 on top
  let history = [];        // { product, direction } most recent last
  let offset = 0;
  let remaining = 0;
  let loading = false;
  let busy = false;        // a card is mid-flight

  /* ---------- data ---------- */

  async function fill() {
    if (loading) return;
    loading = true;
    try {
      const page = await api.deck({ offset });
      // The ledger is written when a card is decided, but a page is requested
      // before that, so filter again here — otherwise a fast swiper can be
      // handed a card they just dismissed.
      const fresh = page.items.filter(p => !store.hasSeen(p.id) && !queue.some(q => q.id === p.id));
      queue.push(...fresh);
      offset += page.items.length;
      remaining = page.remaining;
    } finally {
      loading = false;
    }
    render();
  }

  const preload = () => {
    for (const p of queue.slice(1, 1 + PRELOAD)) {
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
          ${p.promoted ? '<span class="promo-flag">Promoted</span>' : ''}
          <div class="stamp keep">Saved</div>
          <div class="stamp pass">Pass</div>
        </div>
        <div class="meta">
          <div class="brand">${esc(p.seller.brand_name)}</div>
          <h2>${esc(p.title)}</h2>
          <div class="row">
            <span class="price num">${money(p.price)}</span>
            <span class="where">${esc(p.city)} · ${esc(p.condition)}</span>
          </div>
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
    if (!queue.length && (loading || remaining > 0)) {
      deck.append(ghostDeck());
      countEl.textContent = '';
      return;
    }

    if (!queue.length) {
      deck.append(el(`
        <div class="deck-empty">
          <h2>That's everything, for now</h2>
          <p>You have seen every listing that matches you. New products arrive daily — or browse the full catalogue.</p>
          <button class="btn quiet" id="reset-seen">Start the deck again</button>
        </div>`));
      deck.querySelector('#reset-seen').addEventListener('click', () => {
        store.resetSeen(); queue = []; history = []; offset = 0; fill();
      });
      countEl.textContent = '';
      return;
    }
    // Back to front, so the top card is the last child and needs no z-index war.
    for (let d = Math.min(2, queue.length - 1); d >= 0; d--) deck.append(card(queue[d], d));

    // Once, on the first deck of the session — a card that re-enters on every
    // render reads as a bug rather than a flourish.
    if (!revealed) {
      revealed = true;
      deck.classList.add('first-reveal');
      setTimeout(() => deck.classList.remove('first-reveal'), 700);
    }

    countEl.textContent = `${queue.length + remaining} left`;
    api.track('impression', queue[0].id);
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

    const move = ev => {
      if (!dragging || ev.pointerId !== id) return;
      dx = ev.clientX - startX;
      dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) node._dragged = true;
      const t = dx / node.offsetWidth;
      node.style.transform = `translate3d(${dx}px, ${dy * 0.35}px, 0) rotate(${t * 11}deg)`;
      // The card behind leans forward as this one leaves, so the deck reads as
      // a stack of things rather than a stack of pictures.
      parallax(deck, t / THROW);
      // The stamps are the tutorial: the meaning of the gesture appears as the
      // gesture is made, so no first-run overlay is needed.
      keep.style.opacity = Math.max(0, Math.min(1, t / THROW));
      pass.style.opacity = Math.max(0, Math.min(1, -t / THROW));
    };

    const up = ev => {
      if (!dragging || ev.pointerId !== id) return;
      dragging = false;
      node.releasePointerCapture(id);
      const t = dx / node.offsetWidth;
      const v = Math.abs(dx) / Math.max(1, performance.now() - startT);
      if (Math.abs(t) > THROW || (v > FLICK && Math.abs(dx) > 30)) fly(node, product, dx > 0 ? 1 : -1);
      else {
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

  function fly(node, product, dir) {
    if (busy || !node?.classList.contains('swipe-card') || !product) return;
    busy = true;
    node.classList.add('settling');
    node.style.transform = `translate3d(${dir * (innerWidth + 220)}px, -40px, 0) rotate(${dir * 22}deg)`;
    node.style.opacity = '0';
    node.querySelector(dir > 0 ? '.stamp.keep' : '.stamp.pass').style.opacity = '1';
    setTimeout(() => { commit(product, dir); busy = false; }, 230);
  }

  function commit(product, dir) {
    queue = queue.filter(p => p.id !== product.id);
    store.markSeen(product.id);
    history.push({ product, dir, wished: false });
    let saved = false;
    if (dir > 0 && !store.wished(product.id)) {
      store.toggleWish(product.id);
      history.at(-1).wished = true;
      saved = true;
      toast('Saved to your wishlist');
    }
    api.track(dir > 0 ? 'keep' : 'pass', product.id);
    undoBtn.disabled = false;
    if (queue.length <= 10 && remaining > 0) fill();
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
    if (!top || !queue.length || busy) return;
    fly(top, queue[0], dir);
  }

  function undo() {
    const last = history.pop();
    if (!last) return;
    store.unsee(last.product.id);
    // Only unwish what the swipe itself added — a product the buyer had already
    // saved from the grid must survive an undo here.
    if (last.wished) store.toggleWish(last.product.id);
    queue.unshift(last.product);
    undoBtn.disabled = history.length === 0;
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
  fill();
  render();
  return root;
}

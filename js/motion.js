/* The moving parts of the motion system — the pieces that need to know where
 * something is on screen, which CSS alone cannot.
 *
 * Everything here is decorative and must degrade to nothing: if an element has
 * gone, if the browser refuses an animation, or if the reader has asked for
 * reduced motion, the app still works and the state still changes. Nothing in
 * this file is allowed to be load-bearing.
 */

export const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/* A burst of dots out of a point — used when something is saved. Positioned
   inside `host`, which needs position:relative (every caller has it). */
export function burst(host, count = 10) {
  if (!host || reducedMotion()) return;
  const layer = document.createElement('span');
  layer.className = 'burst';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('i');
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const distance = 34 + Math.random() * 26;
    dot.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    dot.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    dot.style.animationDelay = `${Math.random() * 60}ms`;
    layer.append(dot);
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 800);
}

export function pop(node) {
  if (!node || reducedMotion()) return;
  node.classList.remove('popped');
  void node.offsetWidth;          // restart the animation on a repeat tap
  node.classList.add('popped');
  setTimeout(() => node.classList.remove('popped'), 460);
}

/* Flies a copy of an image from wherever it is into the bag tab, so the count
   changing is explained rather than merely noticed. Falls back to the plain
   count change when either end is missing. */
export function magnetToBag(fromEl, { onArrive } = {}) {
  if (!fromEl || reducedMotion()) { onArrive?.(); return; }

  const from = fromEl.getBoundingClientRect();
  if (!from.width) { onArrive?.(); return; }

  // The product page deliberately hides the tab bar — the sticky buy button
  // takes that space — so the bag tab is often not mounted when this runs.
  // Aim at where it sits on the screen the buyer is about to land on, rather
  // than skipping the animation on the one screen it matters most.
  const tab = document.querySelector('.tab[href="#/bag"]');
  const to = tab && tab.getBoundingClientRect().width
    ? tab.getBoundingClientRect()
    : (() => {
        const frame = document.getElementById('app').getBoundingClientRect();
        const w = frame.width / 5;                       // five tabs
        return { left: frame.right - w, width: w, top: innerHeight - 62, height: 62 };
      })();

  const flyer = document.createElement('div');
  flyer.className = 'magnet';
  flyer.setAttribute('aria-hidden', 'true');
  Object.assign(flyer.style, {
    left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`
  });
  const img = document.createElement('img');
  img.src = fromEl.currentSrc || fromEl.src;
  flyer.append(img);
  document.body.append(flyer);

  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = Math.max(0.12, 26 / Math.max(from.width, from.height));

  requestAnimationFrame(() => {
    flyer.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
    flyer.style.opacity = '0.25';
    flyer.style.borderRadius = '50%';
  });

  setTimeout(() => {
    flyer.remove();
    // The tab may only appear on the screen we are navigating to, so bump
    // whichever one is mounted by the time the flight lands.
    const landed = document.querySelector('.tab[href="#/bag"]');
    if (landed) {
      landed.classList.add('bumped');
      setTimeout(() => landed.classList.remove('bumped'), 460);
    }
    onArrive?.();
  }, 620);
}

/* The next card leans forward while the top one is dragged. Purely a depth cue:
   the deck should feel like a stack of things, not a stack of pictures. */
export function parallax(deck, progress) {
  if (reducedMotion()) return;
  const cards = deck.children;
  // Last child is the top card; the one before it is what shows through.
  const behind = cards[cards.length - 2];
  if (!behind) return;
  const t = Math.min(1, Math.abs(progress));
  behind.style.transform =
    `translate3d(0, ${9 - t * 6}px, 0) scale(${0.965 + t * 0.03})`;
}

export function resetParallax(deck) {
  const behind = deck.children[deck.children.length - 2];
  if (behind) behind.style.transform = 'translate3d(0,9px,0) scale(0.965)';
}

/* Skeleton cards shown while the next page of the deck is fetched — the deck
   never goes blank, so a pause reads as loading rather than as the end. */
export function ghostDeck(message = 'Finding more for you…') {
  const wrap = document.createElement('div');
  wrap.className = 'ghosts';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
    ${'<div class="ghost-card"><span class="sk photo"></span><span class="sk line a"></span><span class="sk line b"></span><span class="sk line c"></span></div>'.repeat(3)}
    <p class="refill-note">${message}</p>`;
  return wrap;
}

/* The four states a parcel moves through, drawn as a rail. Shared by the seller
   inbox and the buyer's order screen so they can never disagree about the
   order of events. */
const STOPS = [
  ['placed', 'Placed'], ['confirmed', 'Confirmed'],
  ['dispatched', 'On its way'], ['delivered', 'Delivered']
];

export function statusRail(status) {
  const wrap = document.createElement('div');
  wrap.className = 'rail';
  wrap.setAttribute('role', 'img');

  if (status === 'refused' || status === 'cancelled') {
    wrap.setAttribute('aria-label', `Parcel ${status}`);
    wrap.innerHTML =
      `<div class="stop on refused"><i></i><span>${status === 'refused' ? 'Refused' : 'Cancelled'}</span></div>`;
    return wrap;
  }

  const at = Math.max(0, STOPS.findIndex(([s]) => s === status));
  wrap.setAttribute('aria-label', `Parcel ${STOPS[at][1].toLowerCase()}`);
  STOPS.forEach(([, label], i) => {
    if (i > 0) {
      const link = document.createElement('span');
      link.className = `link${i <= at ? ' filled' : ''}`;
      link.innerHTML = '<b></b>';
      wrap.append(link);
    }
    const stop = document.createElement('div');
    stop.className = `stop${i <= at ? ' on' : ''}${i === at ? ' now' : ''}`;
    stop.innerHTML = `<i></i><span>${label}</span>`;
    wrap.append(stop);
  });
  return wrap;
}

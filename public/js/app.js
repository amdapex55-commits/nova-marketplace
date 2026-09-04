/* Boot and routing.
 *
 * Hash routing, because the buyer app must work as a plain static upload with
 * no server rewrite rules — the same reason NovaCars uses Cloudflare's SPA
 * fallback rather than a _redirects file. Every screen is rebuilt on entry;
 * there is no virtual DOM and none of these screens is heavy enough to need one.
 */
import { api } from './api.js';
import { store } from './store.js';
import { el, ICON } from './ui.js';
import { onboarding, browseScreen, searchScreen, wishlistScreen, productScreen } from './views.js';
import { deckScreen } from './deck.js';
import { bagScreen, checkoutScreen, orderScreen, ordersScreen } from './checkout.js';

const app = document.getElementById('app');
const splash = document.getElementById('splash');

const go = hash => { location.hash = hash; };

const TABS = [
  { hash: '#/deck',     label: 'For you',  icon: ICON.cards },
  { hash: '#/browse',   label: 'Browse',   icon: ICON.grid },
  { hash: '#/search',   label: 'Search',   icon: ICON.search },
  { hash: '#/wishlist', label: 'Saved',    icon: ICON.heart },
  { hash: '#/bag',      label: 'Bag',      icon: ICON.bag }
];

function tabBar(current) {
  const nav = el('<nav class="tabs" aria-label="Main"></nav>');
  for (const t of TABS) {
    const wished = store.get().wishlist.length;
    const bagged = store.bagCount();
    const pip = t.hash === '#/bag' && bagged ? bagged : t.hash === '#/wishlist' && wished ? wished : 0;
    const a = el(`
      <a class="tab" href="${t.hash}"${current === t.hash ? ' aria-current="page"' : ''}>
        ${t.icon}<span>${t.label}</span>
        ${pip ? `<span class="pip num" aria-hidden="true">${pip > 99 ? '99+' : pip}</span>` : ''}
      </a>`);
    nav.append(a);
  }
  return nav;
}

let current = null;

async function paint(builder, { tab = null } = {}) {
  // Let a screen clean up global listeners (the deck binds arrow keys).
  current?.dispatchEvent(new CustomEvent('screen:leave'));
  const screen = await builder();
  current = screen;
  app.replaceChildren(screen);
  if (tab) app.append(tabBar(tab));
  app.setAttribute('aria-busy', 'false');
  // Each screen owns its own scroll pane, so a new screen must start at its top
  // — otherwise a product opened from halfway down the grid opens halfway down.
  screen.querySelector('.scroll')?.scrollTo(0, 0);
  scrollTo(0, 0);
}

async function route() {
  const [, name, arg] = (location.hash || '#/deck').split('/');
  const state = store.get();

  if (!state.onboarded && name !== 'onboard') return go('#/onboard');

  switch (name) {
    case 'onboard': {
      const { interests } = await api.meta();
      return paint(() => onboarding({ interests, onDone: () => go('#/deck') }));
    }
    case 'browse':
      return paint(() => browseScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/browse' });
    case 'search':
      return paint(() => searchScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/search' });
    case 'wishlist':
      return paint(() => wishlistScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/wishlist' });
    case 'p':
      return paint(() => productScreen({ id: arg, onBack: () => history.back(), onBag: () => go('#/bag') }));
    case 'bag':
      return paint(() => bagScreen({
        onOpen: id => go(`#/p/${id}`),
        onCheckout: { go: () => go('#/checkout'), refresh: () => route() }
      }), { tab: '#/bag' });
    case 'checkout':
      return paint(() => checkoutScreen({ onBack: () => go('#/bag'), onPlaced: code => go(`#/order/${code}`) }));
    case 'orders':
      return paint(() => ordersScreen({ onOpen: code => go(`#/order/${code}`) }), { tab: '#/bag' });
    case 'order':
      return paint(() => orderScreen({ code: arg, onHome: () => go('#/deck'), onOrders: () => go('#/orders') }));
    default:
      return paint(() => deckScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/deck' });
  }
}

addEventListener('hashchange', route);

/* The splash covers exactly one round trip: the catalogue request. It lifts
   when the data is in and the first screen is built — never on a timer alone,
   because a fake wait is the one thing a loading screen must not be. A floor of
   1.1s keeps the animation from flashing on a warm cache. */
(async function boot() {
  const floor = new Promise(r => setTimeout(r, 1100));
  try {
    await Promise.all([api.meta(), route()]);
  } catch (err) {
    console.error(err);
    app.replaceChildren(el('<div class="screen"><div class="empty"><h2>Something went wrong</h2><p>Reload the page. If it keeps happening, your connection dropped mid-load.</p></div></div>'));
  }
  await floor;
  splash.classList.add('out');
  setTimeout(() => splash.remove(), 400);
})();

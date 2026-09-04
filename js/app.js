/* Boot and routing.
 *
 * Hash routing, because the buyer app must work as a plain static upload with
 * no server rewrite rules — the same reason NovaCars uses Cloudflare's SPA
 * fallback rather than a _redirects file. Every screen is rebuilt on entry;
 * there is no virtual DOM and none of these screens is heavy enough to need one.
 */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON } from './ui.js';
import { onboarding, wishlistScreen, productScreen, legalScreen } from './views.js';
import { browseScreen, searchScreen } from './browse.js';
import { shopScreen, offersScreen, inboxScreen, threadScreen, accountScreen } from './shop.js';
import { account, wireGate } from './account.js';
import { deckScreen } from './deck.js';
import { bagScreen, checkoutScreen, orderScreen, ordersScreen } from './checkout.js';

const app = document.getElementById('app');

/* account.js is deliberately free of imports from the app's own modules — it is
   the only file a second front end would need to copy — so the helpers it uses
   are handed to it once, here. */
wireGate({ el, esc, api, store });
const splash = document.getElementById('splash');

const go = hash => { location.hash = hash; };

/* Five tabs, not six. Offers earns one because a sale is a reason to come back;
   Search gives up its tab because it is a thing you reach for with intent, and
   it now sits at the top of Browse where it belongs. */
const TABS = [
  { hash: '#/deck',     label: 'For you', icon: ICON.cards },
  { hash: '#/browse',   label: 'Browse',  icon: ICON.grid },
  { hash: '#/offers',   label: 'Offers',  icon: ICON.tag },
  { hash: '#/wishlist', label: 'Saved',   icon: ICON.heart },
  { hash: '#/bag',      label: 'Bag',     icon: ICON.bag }
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

/* Signed in, the account is reachable from every screen; signed out there is
   nothing to reach, and a sign-in prompt on a browsing app is exactly the
   friction the no-account decision exists to avoid. */
function accountLink() {
  if (!account.signedIn) return null;
  const a = el(`<a class="acct-chip" href="#/account" aria-label="Your account">${ICON.user}</a>`);
  return a;
}

async function paint(builder, { tab = null } = {}) {
  // Let a screen clean up global listeners (the deck binds arrow keys).
  current?.dispatchEvent(new CustomEvent('screen:leave'));
  const screen = await builder();
  current = screen;
  app.replaceChildren(screen);
  // Slot the account chip into whichever screen has a header.
  const top = screen.querySelector('.top');
  const chip = accountLink();
  if (top && chip && !top.querySelector('.acct-chip')) top.append(chip);
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
      return paint(() => browseScreen({ onOpen: id => go(`#/p/${id}`), onSearch: () => go('#/search') }), { tab: '#/browse' });
    case 'search':
      return paint(() => searchScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/browse' });
    case 'offers':
      return paint(() => offersScreen({ onOpen: id => go(`#/p/${id}`) }), { tab: '#/offers' });
    case 'shop':
      return paint(() => shopScreen({
        id: arg,
        onOpen: id => go(`#/p/${id}`),
        onBack: () => history.back(),
        onMessage: (sellerId, productId) => go(`#/ask/${sellerId}${productId ? '/' + productId : ''}`)
      }));
    case 'account':
      return paint(() => accountScreen({
        onOrder: code => go(`#/order/${code}`),
        onSignedOut: () => go('#/deck')
      }), { tab: '#/bag' });
    case 'inbox':
      return paint(() => inboxScreen({ onOpen: id => go(`#/thread/${id}`) }), { tab: '#/bag' });
    case 'thread':
      return paint(() => threadScreen({ id: arg, onBack: () => go('#/inbox') }));
    case 'ask': {
      // Opening (or re-opening) the one thread this device has with that shop,
      // then going straight to it — the buyer never sees a "creating…" step.
      const [, , sellerId, productId] = location.hash.split('/');
      return paint(async () => {
        const t = await api.msg.open({
          sellerId, productId: productId || null,
          name: store.get().contact?.name || null
        });
        location.replace(`#/thread/${t.id}`);
        return el('<div class="screen"><div class="empty"><p>Opening…</p></div></div>');
      });
    }
    case 'wishlist':
      return paint(() => wishlistScreen({
        onOpen: id => go(`#/p/${id}`),
        onCheckout: () => go('#/bag')
      }), { tab: '#/wishlist' });
    case 'p':
      return paint(() => productScreen({
        id: arg,
        onBack: () => history.back(),
        onBag: () => go('#/bag'),
        onShop: sellerId => go(`#/shop/${sellerId}`),
        onMessage: (sellerId, productId) => go(`#/ask/${sellerId}/${productId}`),
        // The shop preview and the related row both open other listings.
        onOpen: pid => go(`#/p/${pid}`)
      }));
    case 'bag':
      return paint(() => bagScreen({
        onOpen: id => go(`#/p/${id}`),
        onCheckout: { go: () => go('#/checkout'), refresh: () => route() }
      }), { tab: '#/bag' });
    case 'checkout':
      return paint(() => checkoutScreen({ onBack: () => go('#/bag'), onPlaced: code => go(`#/order/${code}`) }));
    case 'legal':
      return paint(() => legalScreen({ onBack: () => history.back() }));
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

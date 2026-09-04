/* The control suite, on its own page.
 *
 * Split out of seller.html the way NovaX separates client.html from admin.html:
 * two audiences, two documents, no chance of one loading the other's code.
 *
 * Signing in still happens on the seller page — one door, and the seller side
 * says nothing about this one. What sends an admin here is is_admin(), and that
 * answer comes from Postgres. This file being reachable grants nobody anything:
 * every function it calls re-checks `admins` and refuses a caller who is not in
 * it, so it could be linked from the homepage and still be safe.
 */
import { auth, rpc } from './sb.js';
import { el } from '../ui.js';
import { adminSuite } from './admin.js';

const app = document.getElementById('app');

/* Two different situations, and telling someone to sign in when they already
   are is how a dead end feels like a bug. */
const refuse = (heading, detail, action) => {
  app.replaceChildren(el(`
    <div>
      <div class="bar"><span class="mark">nova<em>.</em></span></div>
      <div class="empty">
        <h2>${heading}</h2>
        <p>${detail}</p>
        <a class="btn" href="${action.href}">${action.label}</a>
      </div>
    </div>`));
  app.setAttribute('aria-busy', 'false');
};

(async function boot() {
  if (!auth.signedIn) {
    return refuse('You are not signed in',
      'Sign in first, then come back to this page.',
      { href: 'seller.html', label: 'Go to sign in' });
  }
  try {
    if (!(await rpc('is_admin'))) {
      return refuse('This page is not for this account',
        'You are signed in, but this account does not have access here.',
        { href: 'seller.html', label: 'Go to my shop' });
    }
    await adminSuite({
      alsoASeller: !!(await rpc('me')),
      onSwitchToShop: () => { location.href = 'seller.html?shop=1'; }
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      await auth.signOut();
      return refuse('Your session has expired',
        'Sign in again to carry on.',
        { href: 'seller.html', label: 'Go to sign in' });
    }
    console.error(err);
    app.replaceChildren(el('<div class="empty"><h2>Could not load</h2><p>Reload the page.</p></div>'));
    app.setAttribute('aria-busy', 'false');
  }
})();

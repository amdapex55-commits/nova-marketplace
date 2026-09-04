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

const sendToSignIn = message => {
  app.replaceChildren(el(`
    <div>
      <div class="bar"><span class="mark">nova<em>.</em></span></div>
      <div class="empty">
        <h2>${message}</h2>
        <p>Sign in first, then come back to this page.</p>
        <a class="btn" href="seller.html">Go to sign in</a>
      </div>
    </div>`));
  app.setAttribute('aria-busy', 'false');
};

(async function boot() {
  if (!auth.signedIn) return sendToSignIn('You are not signed in');
  try {
    if (!(await rpc('is_admin'))) return sendToSignIn('This page is not for this account');
    await adminSuite({
      alsoASeller: !!(await rpc('me')),
      onSwitchToShop: () => { location.href = 'seller.html?shop=1'; }
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) { await auth.signOut(); return sendToSignIn('Your session has expired'); }
    console.error(err);
    app.replaceChildren(el('<div class="empty"><h2>Could not load</h2><p>Reload the page.</p></div>'));
    app.setAttribute('aria-busy', 'false');
  }
})();

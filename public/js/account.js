/* The buyer's account.
 *
 * Browsing, swiping and filling a bag are still account-free — that was right
 * and has not changed. The barrier is at checkout, where an order needs a name,
 * an email and a phone anyway: asking once and keeping them beats asking every
 * time and keeping nothing, and it is the only way order history follows
 * somebody to a new phone.
 *
 * The session is stored under its own key so a seller and a buyer signed in on
 * the same browser do not evict each other.
 */
const cfg = () => window.NOVAMKT;
const KEY = 'nova.buyer.session.v1';

let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { session = null; }

const save = s => {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); }
  catch { /* private mode — the app still works, the session just will not persist */ }
};

async function parse(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || body?.error_description || body?.msg || body?.error
      || `that did not work (${res.status})`;
    const err = new Error(friendly(msg));
    err.status = res.status;
    throw err;
  }
  return body;
}

/* GoTrue's wording is for developers. These are the three a buyer will actually
   hit, in words that tell them what to do next. */
function friendly(msg) {
  const m = String(msg).toLowerCase();
  if (m.includes('already registered') || m.includes('already been registered'))
    return 'There is already an account with that email — sign in instead.';
  if (m.includes('invalid login')) return 'That email and password do not match.';
  if (m.includes('password')) return 'Passwords need at least 8 characters.';
  return msg;
}

export const account = {
  get signedIn() { return !!session?.access_token; },
  get token() { return session?.access_token || null; },
  profile: null,

  async signUp(email, password) {
    const body = await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    }));
    if (body?.access_token) { save(body); return; }
    // Email confirmation is off on this project, so signup returns a session.
    // If it is ever turned back on this keeps the buyer moving rather than
    // stranding them mid-checkout.
    await this.signIn(email, password);
  },

  async signIn(email, password) {
    save(await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    })));
  },

  async refresh() {
    if (!session?.refresh_token) throw new Error('no session');
    save(await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })));
  },

  async signOut() {
    if (session?.access_token) {
      try {
        await fetch(`${cfg().SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: cfg().SUPABASE_ANON_KEY, authorization: `Bearer ${session.access_token}` }
        });
      } catch { /* the local session is cleared either way */ }
    }
    save(null);
    account.profile = null;
  }
};

/* --------------------------------------------------------------- the gate -- */
/* Shown when someone reaches checkout without an account.
 *
 * Four fields, not three. A password is the one thing that cannot be skipped:
 * without a mail provider connected there is no reset link and no magic code,
 * so a password is the only way back in on a second device — which is the whole
 * reason for the account. It is asked for once, and never again.
 */
export function signUpGate(opts) {
  const sheet = opts.el(`
    <div class="sheet gate" role="dialog" aria-modal="true" aria-label="Create your account">
      <div class="sheet-in"><div id="pane"></div></div>
    </div>`);
  buildGate(sheet.querySelector('#pane'), { ...opts, close: () => sheet.remove() });
  document.body.append(sheet);
}

/* The same thing as a screen rather than a sheet. Used at the bag, where it is
   a step in the flow and not an interruption of one — and where a sheet over a
   placeholder was leaving people on "one moment…" with nothing behind it. */
export function gateScreen({ onDone, onCancel }) {
  const root = gateEl(`
    <div class="screen gate-screen">
      <div class="scroll"><div id="pane"></div></div>
    </div>`);
  buildGate(root.querySelector('#pane'), { el: gateEl, esc: gateEsc, api: gateApi, store: gateStore, onDone, onCancel });
  return root;
}

function buildGate(pane, { el, esc, api, store, onDone, onCancel, close }) {
  let mode = 'up';
  const known = store.get().contact || {};

  const render = () => {
    pane.replaceChildren(el(`
      <div>
        <div class="gate-hero">
          <div class="gate-mark">nova<em>.</em></div>
          <h2>${mode === 'up' ? 'One account, then you never fill this in again' : 'Welcome back'}</h2>
          <p>${mode === 'up'
            ? 'We need a name, a number and an address to deliver anyway. Keep them once and every order after this is three taps.'
            : 'Sign in and your addresses and past orders come with you.'}</p>
        </div>
        <div class="group"><div class="inner" id="form"></div></div>
      </div>`));

    const form = pane.querySelector('#form');
    const field = (id, label, opts = {}) => el(`
      <div class="field">
        <label for="${id}">${esc(label)}${opts.hint ? ` <span class="hint">${esc(opts.hint)}</span>` : ''}</label>
        <input id="${id}" type="${opts.type || 'text'}"${opts.mode ? ` inputmode="${opts.mode}"` : ''}${
          opts.auto ? ` autocomplete="${opts.auto}"` : ''} value="${esc(opts.value || '')}" placeholder="${esc(opts.ph || '')}">
      </div>`);

    if (mode === 'up') {
      form.append(
        field('g-name', 'Your name', { auto: 'name', value: known.name || '' }),
        field('g-email', 'Email', { type: 'email', mode: 'email', auto: 'email', ph: 'you@example.com' }),
        field('g-phone', 'Mobile number', { hint: 'the rider calls this', type: 'tel', mode: 'tel', auto: 'tel', value: known.phone || '', ph: '0300 1234567' }),
        field('g-pass', 'Create a password', { hint: 'at least 8 characters', type: 'password', auto: 'new-password' })
      );
    } else {
      form.append(
        field('g-email', 'Email', { type: 'email', mode: 'email', auto: 'email' }),
        field('g-pass', 'Password', { type: 'password', auto: 'current-password' })
      );
    }

    const go = el(`<button class="btn block" id="g-go">${mode === 'up' ? 'Create my account' : 'Sign in'}</button>`);
    const err = el('<div class="err" id="g-err" role="alert" hidden></div>');
    const swap = el(`<button class="btn ghost block">${mode === 'up' ? 'I already have an account' : 'I need an account'}</button>`);
    const back = el('<button class="btn quiet block">Back to my bag</button>');
    form.append(go, err, swap, back);

    swap.addEventListener('click', () => { mode = mode === 'up' ? 'in' : 'up'; render(); });
    back.addEventListener('click', () => { close?.(); onCancel?.(); });

    const show = m => { err.hidden = false; err.textContent = m; };

    go.addEventListener('click', async () => {
      err.hidden = true;
      const v = id => (pane.querySelector('#' + id)?.value || '').trim();
      const email = v('g-email').toLowerCase();
      const pass = pane.querySelector('#g-pass').value;
      const phoneDigits = v('g-phone').replace(/\D/g, '').replace(/^0092|^92/, '').replace(/^0/, '');

      if (!email.includes('@') || !email.includes('.')) return show('Check the email address.');
      if (pass.length < 8) return show('Passwords need at least 8 characters.');
      if (mode === 'up') {
        if (v('g-name').length < 2) return show('What should we call you?');
        if (!/^3\d{9}$/.test(phoneDigits)) return show('Enter a Pakistani mobile number, like 0300 1234567.');
      }

      go.disabled = true;
      go.textContent = mode === 'up' ? 'Creating…' : 'Signing in…';
      try {
        if (mode === 'up') {
          await account.signUp(email, pass);
          await api.registerBuyer(v('g-name'), email, '0' + phoneDigits);
        } else {
          await account.signIn(email, pass);
          const me = await api.meBuyer();
          // Signed in on an account that never finished registering — finish it
          // rather than leaving them with no name on their orders.
          if (!me) { mode = 'up'; render(); show('Just a couple more details.'); return; }
        }
        close?.();
        onDone(account.profile);
      } catch (e) {
        show(e.message);
        go.disabled = false;
        go.textContent = mode === 'up' ? 'Create my account' : 'Sign in';
      }
    });
  };

  render();
}

/* gateScreen builds itself, so it needs the same helpers the sheet is handed. */
let gateEl, gateEsc, gateApi, gateStore;
export function wireGate({ el, esc, api, store }) {
  gateEl = el; gateEsc = esc; gateApi = api; gateStore = store;
}

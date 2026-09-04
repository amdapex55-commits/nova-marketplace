/* A very small Supabase client: auth, RPC, table reads, storage.
 *
 * Not @supabase/supabase-js. That package is ~60 KB gzipped and this file uses
 * maybe a tenth of it — and the whole repo has no build step, so adding it
 * would mean either a bundler or a CDN script the artifact CSP would block
 * anyway. Everything below is fetch against documented REST endpoints.
 *
 * The session lives in localStorage. Supabase's own client does the same; the
 * access token is a short-lived JWT and the refresh token is single-use.
 */

const cfg = () => window.NOVAMKT;
const KEY = 'nova.seller.session.v1';

let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { session = null; }

const save = s => {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* private mode */ }
};

const authHeaders = () => ({
  apikey: cfg().SUPABASE_ANON_KEY,
  authorization: `Bearer ${session?.access_token || cfg().SUPABASE_ANON_KEY}`
});

async function parse(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    // Postgres RAISE messages arrive under `message`; PostgREST's own errors
    // sometimes only under `error_description`. Show whichever exists, because
    // "400 Bad Request" tells a seller nothing.
    const msg = body?.message || body?.error_description || body?.error || body?.msg || `request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = body?.code;
    throw err;
  }
  return body;
}

/* Access tokens expire in an hour. Rather than a timer, retry once on 401 —
   the seller notices nothing, and a workspace left open overnight still works. */
async function withRefresh(run) {
  try {
    return await run();
  } catch (err) {
    if (err.status !== 401 || !session?.refresh_token) throw err;
    await auth.refresh();
    return run();
  }
}

export const auth = {
  get session() { return session; },
  get signedIn() { return !!session?.access_token; },

  async signUp(email, password) {
    const body = await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    }));
    // With email confirmation on, signup returns a user but no session — the
    // seller has to click the link first. Say so rather than looking broken.
    if (body?.access_token) save(body);
    return { needsConfirmation: !body?.access_token, user: body?.user || body };
  },

  async signIn(email, password) {
    const body = await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    }));
    save(body);
    return body;
  },

  async refresh() {
    const body = await parse(await fetch(`${cfg().SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg().SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }));
    save(body);
    return body;
  },

  async signOut() {
    if (session?.access_token) {
      // Best effort: the local session is cleared either way, so a network
      // failure must not leave someone apparently still signed in.
      try {
        await fetch(`${cfg().SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: authHeaders() });
      } catch { /* ignore */ }
    }
    save(null);
  }
};

/* Calls a Postgres function. Nearly everything the workspace does goes through
   one of these rather than table access, so the rules live in SQL where they
   can be tested. */
export const rpc = (name, args = {}) => withRefresh(async () =>
  parse(await fetch(`${cfg().SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(args)
  })));

export const db = {
  select: (table, query = '') => withRefresh(async () =>
    parse(await fetch(`${cfg().SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: authHeaders() }))),

  insert: (table, row) => withRefresh(async () =>
    parse(await fetch(`${cfg().SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify(row)
    }))),

  update: (table, query, patch) => withRefresh(async () =>
    parse(await fetch(`${cfg().SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify(patch)
    }))),

  remove: (table, query) => withRefresh(async () =>
    parse(await fetch(`${cfg().SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: 'DELETE', headers: authHeaders()
    })))
};

/* ------------------------------------------------------------------ storage */

const BUCKET = 'product-photos';

export const storage = {
  publicUrl: key => `${cfg().SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`,

  upload: (key, blob) => withRefresh(async () =>
    parse(await fetch(`${cfg().SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': blob.type || 'image/webp',
        // A retry after a failure must overwrite its own debris rather than
        // colliding with it — that loop is what poisoned a NovaCars stock number.
        'x-upsert': 'true'
      },
      body: blob
    }))),

  /* Storage has no cascade, so this is called explicitly wherever a row goes.
     Never let a failure here block the delete the seller asked for — an orphan
     file is a nuisance, a listing that will not delete is a bug.

     The one thing that must not pass quietly: a delete the policy refuses comes
     back as **200 with an empty array**, not as an error. Verified against the
     live project. So a broken policy would look exactly like a successful
     cleanup while every file stayed behind, and the orphans would surface much
     later as uploads colliding with debris. Count what actually went. */
  async remove(keys) {
    if (!keys?.length) return { requested: 0, removed: 0 };
    try {
      const removed = await withRefresh(async () => parse(await fetch(`${cfg().SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: keys })
      })));
      const count = Array.isArray(removed) ? removed.length : 0;
      if (count < keys.length) {
        console.warn(
          `storage: asked to remove ${keys.length} object(s), removed ${count}. ` +
          'The rest are orphaned and will collide with a later upload.', keys);
      }
      return { requested: keys.length, removed: count };
    } catch (err) {
      console.warn('could not remove photo objects', keys, err);
      return { requested: keys.length, removed: 0 };
    }
  }
};

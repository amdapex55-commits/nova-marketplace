# Nova Marketplace — buyer app

A marketplace you swipe instead of scroll. This repo is the **client side**:
splash, onboarding, swipe deck, browse, search, wishlist, bag, checkout and
order confirmation. The seller workspace is Phase 1 and is not here yet.

    npm run dev      # http://localhost:54330
    npm test         # order arithmetic
    npm run test:db  # schema, RLS and place_order, against a real Postgres
    npm run check    # both
    npm run seed     # regenerate the demo catalogue
    npm run icons    # favicons, PWA icons and the social share card

Live at https://amdapex55-commits.github.io/nova-marketplace/ — GitHub Pages,
from the `gh-pages` branch, which is `public/` pushed as a subtree:

    git subtree push --prefix public origin gh-pages

Cloudflare (`npm run deploy`) is still the intended production home, because R2
and Workers live there. It needs `wrangler login` first, which is interactive.

No build step. No runtime dependencies. Everything in `package.json` is tooling
that never ships.

## Where things are

    public/            everything Cloudflare serves, and nothing else
      index.html       app shell; the splash is here, not in JS, so it paints first
      config.js        per-environment settings, committed
      css/app.css      the whole visual system
      js/app.js        boot + hash routing
      js/api.js        the ONLY place the app talks to data
      js/store.js      the buyer's device state — the whole buyer-side database
      js/deck.js       the swipe deck
      js/views.js      onboarding, browse, search, product, wishlist
      js/checkout.js   bag, checkout, confirmation
      js/money.mjs     order arithmetic — pure, and covered by tests
      seller.html      the seller workspace (separate entry point)
      js/seller/       sb.js (tiny Supabase client) · photos.js (resize) · app.js · admin.js
      js/motion.js     the moving parts that need to know where things are
      css/motion.css   the motion system
      data/catalog.json  demo catalogue (generated)
    supabase/
      migrations/      0001 schema · 0002 RLS · 0003 place_order
      local/           test-harness bootstrap; NEVER applied to Supabase
    devserver/         local only; serves ./public and nothing else
    scripts/seed.mjs   generates the catalogue and its placeholder artwork
    scripts/*.test.mjs money arithmetic, and the database
    scripts/make-icons.py  favicons, PWA icons, social share card
    wrangler.jsonc     pins the deploy to ./public

## Decisions already made, so they don't get re-litigated

**Checkout, not a WhatsApp handoff.** The buyer stays on Nova through the
purchase. That is the point: handing the traffic to the seller's DMs at the
moment of intent gives away the only asset the platform has.

**Nova never holds the money.** Sellers pay a subscription; each seller ships
their own parcel and collects their own cash on delivery. So an order is not one
payment — it is a set of **shipments**, one per seller, each priced and settled
independently. `money.mjs` is built around that and `scripts/money.test.mjs`
pins it down. This keeps us out of escrow, refunds and payment licensing.

**No buyer account.** Browsing, wishlisting and filling a bag all happen before
anyone is asked who they are; checkout takes a name and phone as a guest.
`store.js` is therefore the entire buyer-side database, and it lives in
localStorage.

**One light theme, on purpose.** The product is a card on a white ground and a
dark inversion changes what the product is. Every colour is painted explicitly.

**No framework.** A framework is 100–200 KB of JavaScript before a single
product appears, and the whole promise is "smooth on phone Safari".

## The Supabase project

    org       NOVA MARKETPLACE
    ref       fvmgouzjfikhmjfbgtgx
    url       https://fvmgouzjfikhmjfbgtgx.supabase.co
    region    ap-northeast-2 (Seoul)
    key       sb_publishable_lZzUn1QDmCdId3HsiKP0yA_m9PJR7OR   (public by design)

Linked, and all three migrations are applied (`supabase migration list` agrees).
The schema is live; the tables are empty.

**It is a different Supabase account from NovaX and NovaCars.** The
`SUPABASE_ACCESS_TOKEN` in `~/.zshrc` now belongs to the NOVA MARKETPLACE
account and reaches this project only — the CLI can no longer see the Nova Cars
org. NovaCars needs no CLI, so this costs nothing, but it is worth knowing
before wondering where the other projects went.

**`db.fvmgouzjfikhmjfbgtgx.supabase.co` has no A record — IPv6 only — and this
Mac has no IPv6 route.** The CLI works anyway because it goes through the
session pooler (`aws-0-ap-northeast-2.pooler.supabase.com`) on its own. For
psql, use the pooler string with the password in `~/.pgpass`. Do not spend time
debugging the direct host.

Verified against the deployed project, not just locally: `orders`,
`seller_contacts`, `shipments` and `product_stats` all return **401** to the
publishable key; `products` returns live rows only; `place_order` priced a
two-seller basket from the database while ignoring a price the client tried to
send; `get_order` returned `null` for the right code with the wrong phone.

## The data seam

`config.js` still has an empty `SUPABASE_URL`, so `api.js` runs off
`public/data/catalog.json`. **Do not fill it in yet.** The write path is wired
to the real project — `placeOrder`, `order` and `track` all branch on `live()` —
but the READ path is not: `deck`, `browse`, `search`, `product`, `products` and
`sellers` still read fixtures unconditionally. Switching the URL on today would
hand fixture product ids to a real `place_order` and every order would fail.

Two things have to happen first, in this order:

1. **Wire the read path** in `api.js` to PostgREST — the deck query, the browse
   list, `search` against the `search` tsvector plus `pg_trgm`, and the product
   fetch with its photos.
2. **Get real rows in.** The demo catalogue is placeholder artwork and should
   never appear on a live storefront as if it were stock. Real products arrive
   with the seller workspace (Phase 1) and the R2 upload pipeline.

Both prerequisites are now written and tested in `supabase/`:

1. **`place_order` is a server-side RPC in one transaction.** It re-reads prices
   and stock with the product rows locked, splits the bag into shipments, and
   decrements stock last. The browser sends ids and quantities only — a price
   that arrives from a browser is a price an attacker chose.
2. **`20260903230002_rls.sql` revokes before it grants.** Supabase pre-grants `anon` broad
   access to `public`, so a GRANT only ever adds to it.
   `supabase/local/bootstrap.sql` reproduces those permissive defaults *before*
   the migrations run, so the local suite fails if the revoke stops working.
   A test environment stricter than production is the worst way to be wrong.

Sensitive seller data lives in `seller_contacts`, a separate table with no
`anon` grant at all — rather than relying on column-level grants, which do not
restrict anything on Supabase.

## The seller workspace

`seller.html` — sign up, register a shop, list products with photographs, and
work the order inbox. It talks to the **real** Supabase project; the buyer app
does not (see the seam above). The two share `css/app.css` and `js/ui.js`.

**Approval is per seller, once.** A new shop lands on `pending` and can build
listings straight away; they go live the moment the shop is approved. A queue
that grows with every listing forever is not something one person can work.

**Photographs are resized in the seller's browser** into three WebP variants
(400 / 800 / 1600w) before anything is uploaded — a 4 MB camera photo would
otherwise cost bandwidth twice and be shown once. One `photos` row per
photograph, keyed without the variant suffix, under a **random** id.

Photos live in Supabase Storage for now. R2 is still the plan — no egress
charge is the only thing that makes 100k images affordable — and moving is a
copy plus one base URL in `js/seller/storage.js`. Two things to keep in mind:
**Storage has no cascade**, so `delete_product()` returns the object keys for
the caller to clear; and a delete the policy refuses comes back as **200 with an
empty array**, not an error, so `storage.remove()` counts what actually went and
warns when it is short.

**Approving a seller has no UI yet.** Until the admin panel exists:

    update sellers set status = 'active' where brand_name = '…';

## Motion

`css/motion.css` and `js/motion.js`. One idea runs through it: **the dot**. It
orbits on the splash, it is the pip on the tab bar, it bursts when something is
saved, it flies into the bag, it draws the tick on a placed order, and it rings
a photograph while it uploads. A single mark doing every job is what stops a
handful of screens feeling like a handful of screens.

Transform and opacity only, so none of it triggers layout. Everything
decorative is `aria-hidden` and `pointer-events: none`, and every effect is off
under `prefers-reduced-motion` with the app still working.

**Name motion classes specifically.** A bare `.ghost` for the skeleton cards
matched every `.btn.ghost` in the app and gave each secondary button
`position:absolute; opacity:.5` — a half-transparent sheet across the whole
page. `scripts/lint-css.mjs` now fails the build on a bare single-class rule in
`motion.css` whose name is also used elsewhere.

## Administration

There is no separate admin site and no second login. Which suite renders is
decided by `is_admin()`, which reads a table that has **no grant for anyone** —
`anon` and `authenticated` both get 401 on it.

**The gate is in Postgres, not in the front end.** Every `admin_*` function
re-checks `admins` and refuses a caller who is not in it, whatever screen the
request came from. The routing in `js/seller/app.js` decides what to *draw* and
carries no authority: the JavaScript is public, so anything it alone enforced
would be worth nothing.

Adding an admin (SQL editor — deliberately not in this repo, which is public and
where a committed list of admin addresses would be a list of accounts worth
attacking):

    insert into admins (email, note) values ('someone@example.com', 'why');

Approving a shop releases every listing queued behind it; suspending pulls them
back out of the deck in the same motion. Promotion is admin-only — it is
something we sell, and a seller must not be able to help themselves to it.

## Auth: no email confirmation, on purpose

`mailer_autoconfirm` is **on**, so signing up creates an account and signs the
seller straight in. It was off, but nothing could deliver the mail: no SMTP
provider is connected, and Supabase's shared sender throttles to a handful an
hour — so the confirmation link the screen promised often never arrived. A
sign-up that dead-ends is a worse failure than one that never asked.

**What actually gates a shop is a person.** Every new seller lands on `pending`
and reaches no buyer until an admin approves them by hand, so an unverified
email address buys nobody anything.

What this costs, and it is real:

- **No password reset.** It needs email. The sign-up form says so; until SMTP
  exists, reset a password from the Supabase dashboard.
- **Anyone can sign up with somebody else's address.** They still cannot sell
  without approval, and the phone number is checked by hand at that point.
- **A typo'd email is unrecoverable** by the seller themselves.

Connect a provider (Resend, Brevo) and this is the first thing to reverse: set
`mailer_autoconfirm` false, and `signUp()` starts returning no session — it
already falls back to signing in, so handle the confirmation case there.

## Not built yet

The buyer app's read path against PostgREST · R2 instead of Supabase Storage ·
buyer-facing order status · an admin panel for approving sellers and marking
subscriptions paid · report-a-listing · subscription billing · a custom SMTP
provider — which would restore email confirmation and password reset, neither of
which exists today.
See the vault: `Nova OS / Nova Marketplace`.

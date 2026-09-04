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

## The data seam

`config.js` has an empty `SUPABASE_URL`, so `api.js` runs off
`public/data/catalog.json` — same client code, same render path, fixtures
instead of Postgres. Filling in the URL and key is the only change needed to
point the buyer app at a real database.

Both prerequisites are now written and tested in `supabase/`:

1. **`place_order` is a server-side RPC in one transaction.** It re-reads prices
   and stock with the product rows locked, splits the bag into shipments, and
   decrements stock last. The browser sends ids and quantities only — a price
   that arrives from a browser is a price an attacker chose.
2. **`0002_rls.sql` revokes before it grants.** Supabase pre-grants `anon` broad
   access to `public`, so a GRANT only ever adds to it.
   `supabase/local/bootstrap.sql` reproduces those permissive defaults *before*
   the migrations run, so the local suite fails if the revoke stops working.
   A test environment stricter than production is the worst way to be wrong.

Sensitive seller data lives in `seller_contacts`, a separate table with no
`anon` grant at all — rather than relying on column-level grants, which do not
restrict anything on Supabase.

## Not built yet

Seller workspace and the R2 upload pipeline · seller order inbox (the schema
and policies exist; the screens do not) · buyer-facing order status ·
moderation queue and report-a-listing · subscription billing · admin panel.
See the vault: `Nova OS / Nova Marketplace`.

# Nova Marketplace — buyer app

A marketplace you swipe instead of scroll. This repo is the **client side**:
splash, onboarding, swipe deck, browse, search, wishlist, bag, checkout and
order confirmation. The seller workspace is Phase 1 and is not here yet.

    npm run dev      # http://localhost:54330
    npm test         # order arithmetic
    npm run seed     # regenerate the demo catalogue

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
    devserver/         local only; serves ./public and nothing else
    scripts/seed.mjs   generates the catalogue and its placeholder artwork
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

Two things must be true before that switch:

1. **`place_order` has to be a server-side RPC in one transaction** that
   re-reads prices and stock. A price that arrives from a browser is a price an
   attacker chose. The client-side snapshot in `checkout.js` is for display.
2. **`REVOKE ALL … FROM anon` before granting anything.** Supabase pre-grants
   `anon` broad access to `public`, so a column-level GRANT only adds to it.

## Not built yet

Seller workspace and the R2 upload pipeline (Phase 1) · order status and
tracking · seller order inbox · moderation queue and report-a-listing ·
subscription billing · admin panel. See the vault: `Nova OS / Nova Marketplace`.

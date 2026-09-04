/* Nova Marketplace runtime configuration.
   No build step: this file is edited per environment and committed.

   SUPABASE_URL is empty until Phase 0 registers a project. While it is empty
   the app runs off public/data/catalog.json — the same client code, the same
   render path, fixtures instead of Postgres. Filling this in is the only change
   needed to point the buyer app at a real database. */

/* The project is real. The publishable key is public by design — it is the key
   the browser is meant to hold, and every policy in supabase/migrations assumes
   an attacker has it. The secret key must NEVER appear in this repo. */
const SUPABASE = {
  SUPABASE_URL: 'https://fvmgouzjfikhmjfbgtgx.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_lZzUn1QDmCdId3HsiKP0yA_m9PJR7OR'
};

window.NOVAMKT = {
  ...SUPABASE,

  /* Which backend the BUYER app reads from. Deliberately separate from whether
     a Supabase project exists, because the seller workspace needs the real one
     while the buyer app is not ready for it: seller.html talks to Postgres
     today, but js/api.js still reads its catalogue from fixtures. Flipping this
     to 'live' before the read path in api.js is wired would hand fixture
     product ids to a real place_order and fail every order.
     Change it in the same commit that wires api.js, not before. */
  BUYER_BACKEND: 'fixtures',

  BRAND: 'Nova',
  TAGLINE: 'Swipe the best of the internet',
  CURRENCY: 'PKR',

  // How many cards the deck asks for at a time. Three are mounted; the rest is
  // a preload window. See js/deck.js.
  DECK_PAGE: 24,

  // Buyers are asked for a city because delivery is priced on it. Kept here so
  // the seller workspace and checkout cannot disagree about the list.
  CITIES: ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad',
           'Multan', 'Peshawar', 'Hyderabad', 'Sialkot', 'Gujranwala', 'Quetta']
};

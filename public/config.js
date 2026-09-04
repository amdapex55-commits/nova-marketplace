/* Nova Marketplace runtime configuration.
   No build step: this file is edited per environment and committed.

   SUPABASE_URL is empty until Phase 0 registers a project. While it is empty
   the app runs off public/data/catalog.json — the same client code, the same
   render path, fixtures instead of Postgres. Filling this in is the only change
   needed to point the buyer app at a real database. */

const LIVE = {
  SUPABASE_URL: '',        // e.g. https://xxxx.supabase.co  — Phase 0
  SUPABASE_ANON_KEY: ''
};

const onLocalhost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const forceLive = new URLSearchParams(location.search).has('live');

window.NOVAMKT = {
  ...(onLocalhost && !forceLive ? { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' } : LIVE),

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

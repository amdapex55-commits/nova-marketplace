/* Generates the demo catalogue: public/data/catalog.json plus placeholder
 * artwork in public/img/p/.
 *
 * Why placeholders and not real photos: Phase 1 (the seller workspace and the
 * R2 upload pipeline) has not been built, so no real seller photograph exists
 * yet. These are deliberately abstract — nobody should mistake them for a
 * product shot — while still giving the swipe deck the 4:5 portrait frame and
 * the visual variety it needs to be judged honestly.
 *
 *   node scripts/seed.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG = path.join(ROOT, 'public', 'img', 'p');
const DATA = path.join(ROOT, 'public', 'data');

/* Deterministic PRNG so re-running the seed does not reshuffle the catalogue
   and produce a noisy git diff. */
let seed = 20260903;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const CITIES = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Hyderabad', 'Sialkot'];

const SELLERS = [
  { id: 's1',  brand: 'Meher Studio',        city: 'Lahore',     interest: 'clothing'  },
  { id: 's2',  brand: 'Kohsar Threads',      city: 'Islamabad',  interest: 'clothing'  },
  { id: 's3',  brand: 'Saanjh Handloom',     city: 'Multan',     interest: 'clothing'  },
  { id: 's4',  brand: 'Denim Bazaar Co.',    city: 'Karachi',    interest: 'clothing'  },
  { id: 's5',  brand: 'Noor Atelier',        city: 'Lahore',     interest: 'clothing'  },
  { id: 's6',  brand: 'Sahil Sportswear',    city: 'Karachi',    interest: 'sports'    },
  { id: 's7',  brand: 'Base Camp Outfitters',city: 'Rawalpindi', interest: 'sports'    },
  { id: 's8',  brand: 'Chai Patti Roastery', city: 'Karachi',    interest: 'food'      },
  { id: 's9',  brand: 'Hunza Pantry',        city: 'Islamabad',  interest: 'food'      },
  { id: 's10', brand: 'Papercut Press',      city: 'Lahore',     interest: 'magazines' },
  { id: 's11', brand: 'The Reading Room',    city: 'Karachi',    interest: 'magazines' },
  { id: 's12', brand: 'Rawal Leatherworks',  city: 'Sialkot',    interest: 'clothing'  }
];

const CATALOG = {
  clothing: {
    nouns: ['Kurta', 'Shalwar Kameez', 'Lawn Suit', 'Kaftan', 'Denim Jacket', 'Straight-Leg Jeans',
            'Linen Shirt', 'Waistcoat', 'Dupatta', 'Shawl', 'Cotton Trousers', 'Embroidered Blouse',
            'Peshawari Chappal', 'Leather Belt', 'Silk Scarf', 'Hoodie', 'Overshirt', 'Wide-Leg Pants'],
    adjs:  ['Handblock', 'Chikankari', 'Indigo', 'Ivory', 'Charcoal', 'Rust', 'Ajrak', 'Khaddar',
            'Raw-Edge', 'Stonewashed', 'Mul Cotton', 'Winter', 'Festive', 'Everyday'],
    price: [1450, 12500], tags: ['clothing', 'style', 'handmade']
  },
  sports: {
    nouns: ['Training Shorts', 'Cricket Bat', 'Yoga Mat', 'Running Tee', 'Gym Duffel', 'Skipping Rope',
            'Football', 'Resistance Bands', 'Trekking Poles', 'Water Bottle', 'Compression Sleeve', 'Track Jacket'],
    adjs:  ['Lightweight', 'All-Weather', 'Pro', 'Grip-Lock', 'Mesh-Back', 'Season 4', 'Trail', 'Club'],
    price: [890, 18500], tags: ['sports', 'fitness', 'outdoors']
  },
  food: {
    nouns: ['Kashmiri Chai Blend', 'Hunza Apricot Jam', 'Wild Acacia Honey', 'Chilgoza Pine Nuts',
            'Cold-Brew Concentrate', 'Chapli Kebab Masala', 'Walnut Halwa', 'Dry Fruit Box',
            'Single-Origin Coffee', 'Saffron Threads', 'Salted Caramel Spread'],
    adjs:  ['Small-Batch', 'Unfiltered', 'Estate', 'Hand-Sorted', 'Roasted Weekly', 'No-Sugar', 'Gift-Boxed'],
    price: [650, 7800], tags: ['food', 'pantry', 'gifts']
  },
  magazines: {
    nouns: ['Quarterly No. 12', 'Design Annual', 'Photo Journal', 'Poetry Chapbook', 'Archive Zine',
            'City Guide', 'Type Specimen', 'Field Notes', 'Print Edition'],
    adjs:  ['Riso-Printed', 'Limited', 'Second Run', 'Collector', 'Bilingual', 'Numbered'],
    price: [750, 4500], tags: ['magazines', 'print', 'collectible']
  }
};

const CONDITIONS = ['New', 'New', 'New', 'Like new', 'Gently used'];

/* ---------- placeholder artwork ---------- */

const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

const MOTIF = {
  clothing:  (a, b) => `<path d="M120 760 C 260 560, 540 560, 680 760 L 680 1000 L 120 1000 Z" fill="${b}" opacity=".55"/>
                        <circle cx="400" cy="330" r="150" fill="${a}" opacity=".5"/>`,
  sports:    (a, b) => `<g opacity=".5">${[0,1,2,3,4].map(i => `<rect x="${-200 + i * 190}" y="0" width="90" height="1400" fill="${b}" transform="rotate(24 400 500)"/>`).join('')}</g>
                        <circle cx="400" cy="500" r="170" fill="none" stroke="${a}" stroke-width="26" opacity=".7"/>`,
  food:      (a, b) => `<circle cx="400" cy="500" r="230" fill="${b}" opacity=".55"/>
                        <circle cx="400" cy="500" r="140" fill="${a}" opacity=".6"/>
                        <circle cx="400" cy="500" r="62"  fill="${b}" opacity=".8"/>`,
  magazines: (a, b) => `<g opacity=".6">
                          <rect x="150" y="250" width="500" height="620" rx="6" fill="${b}"/>
                          <rect x="190" y="210" width="420" height="620" rx="6" fill="${a}" opacity=".85"/>
                          <rect x="240" y="300" width="230" height="18" rx="9" fill="${b}"/>
                          <rect x="240" y="342" width="150" height="18" rx="9" fill="${b}" opacity=".7"/>
                        </g>`
};

function artwork(productId, interest, variant) {
  const h = (hash(productId + variant) % 360);
  const ground = `hsl(${h} 34% ${18 + (hash(productId) % 8)}%)`;
  const a = `hsl(${(h + 28) % 360} 62% 62%)`;
  const b = `hsl(${(h + 320) % 360} 48% 46%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000" width="800" height="1000" role="img" aria-label="Placeholder artwork">
  <rect width="800" height="1000" fill="${ground}"/>
  ${MOTIF[interest](a, b)}
  <rect width="800" height="1000" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2"/>
</svg>`;
}

/* ---------- build ---------- */

await fs.rm(IMG, { recursive: true, force: true });
await fs.mkdir(IMG, { recursive: true });
await fs.mkdir(DATA, { recursive: true });

const products = [];
let n = 0;

for (const seller of SELLERS) {
  const c = CATALOG[seller.interest];
  const count = between(8, 13);
  for (let i = 0; i < count; i++) {
    const id = 'p' + String(++n).padStart(4, '0');
    const title = `${pick(c.adjs)} ${pick(c.nouns)}`;
    const price = Math.round(between(c.price[0], c.price[1]) / 50) * 50;
    const photos = between(1, 3);
    for (let v = 0; v < photos; v++) {
      await fs.writeFile(path.join(IMG, `${id}-${v}.svg`), artwork(id, seller.interest, v));
    }
    products.push({
      id,
      seller_id: seller.id,
      title,
      // Written as a seller would write it — short, specific, no marketing voice.
      description: `${title} from ${seller.brand}. ${pick(['Made in small runs.', 'One of a limited batch.', 'Restocked this month.', 'Ships from our own workshop.'])} ${pick(['Ships in 1–2 working days.', 'Dispatched within 24 hours.', 'Made to order, allow 3 days.'])}`,
      price,
      currency: 'PKR',
      interest: seller.interest,
      tags: [...c.tags, seller.interest],
      condition: pick(CONDITIONS),
      stock: between(1, 14),
      city: seller.city,
      status: 'live',
      photos: Array.from({ length: photos }, (_, v) => `img/p/${id}-${v}.svg`),
      created_at: new Date(Date.now() - between(0, 60) * 86400000).toISOString()
    });
  }
}

const catalog = {
  generated_at: new Date().toISOString(),
  cities: CITIES,
  interests: [
    { id: 'clothing',  label: 'Clothing',  hint: 'Everyday, festive, handmade' },
    { id: 'sports',    label: 'Sport',     hint: 'Training, outdoors, gear' },
    { id: 'food',      label: 'Food',      hint: 'Pantry, chai, gifting' },
    { id: 'magazines', label: 'Print',     hint: 'Zines, journals, collectibles' }
  ],
  sellers: SELLERS.map(s => ({ id: s.id, brand_name: s.brand, city: s.city, rating: (4 + rnd()).toFixed(1), joined: '2026-08' })),
  products
};

await fs.writeFile(path.join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 1));
console.log(`seeded ${products.length} products across ${SELLERS.length} sellers`);

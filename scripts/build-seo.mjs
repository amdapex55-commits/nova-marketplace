/* Generates a crawlable page per live listing, plus a sitemap.
 *
 * The app is a hash-routed single page, which is invisible to a crawler: there
 * is one URL and one empty <div>. These are real files at real paths with real
 * titles, descriptions, images and JSON-LD, and each one redirects a human
 * straight into the app. A crawler sees a product; a person sees the listing.
 *
 * Re-run after listings change:  npm run seo
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'l');
const SITE = process.env.NOVA_SITE || 'https://amdapex55-commits.github.io/nova-marketplace';

const cfg = await fs.readFile(path.join(ROOT, 'public', 'config.js'), 'utf8');
const url = cfg.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
const key = cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
if (!url || !key) { console.error('no Supabase config — nothing to generate'); process.exit(0); }

const rpc = async (name, args = {}) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
};

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const photo = (k, v = 'full') =>
  `${url}/storage/v1/object/public/product-photos/${k}-${v}.webp`;

const page = p => {
  const img = p.photo_keys?.[0] ? photo(p.photo_keys[0]) : `${SITE}/og.png`;
  const desc = (p.description || `${p.title} from ${p.seller.brand_name} in ${p.city}.`)
    .replace(/\s+/g, ' ').slice(0, 155);
  /* Product structured data, so a search engine can show the price and whether
     it is in stock rather than just a blue link. */
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.title, description: desc, image: [img],
    brand: { '@type': 'Brand', name: p.seller.brand_name },
    ...(p.reviews > 0 && p.rating
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.reviews } }
      : {}),
    offers: {
      '@type': 'Offer', price: p.price, priceCurrency: 'PKR',
      availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${SITE}/l/${p.id}.html`,
      seller: { '@type': 'Organization', name: p.seller.brand_name }
    }
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} — ${esc(p.seller.brand_name)} | Nova</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/l/${p.id}.html">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${SITE}/l/${p.id}.html">
<meta property="product:price:amount" content="${p.price}">
<meta property="product:price:currency" content="PKR">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#f3f2ee;color:#161a18;
       display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}
  img{max-width:min(340px,80vw);border-radius:16px}
  h1{font-size:24px;margin:18px 0 4px}
  .p{font-size:20px;font-weight:700}
  a.btn{display:inline-block;margin-top:18px;background:#14614a;color:#fff;
        padding:13px 22px;border-radius:12px;text-decoration:none;font-weight:600}
</style>
<!-- A crawler reads what is above. A person is sent into the app, where the
     listing actually works — sizes, the bag, the seller. -->
<script>location.replace('../#/p/${p.id}');</script>
</head>
<body>
  <img src="${esc(img)}" alt="${esc(p.title)}">
  <h1>${esc(p.title)}</h1>
  <p class="p">Rs ${Number(p.price).toLocaleString('en-PK')}</p>
  <p>${esc(p.seller.brand_name)} · ${esc(p.city)}</p>
  <p>${esc(desc)}</p>
  <a class="btn" href="../#/p/${p.id}">Open on Nova</a>
</body>
</html>`;
};

const { items } = await rpc('browse', { p_limit: 100 });
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
for (const p of items) await fs.writeFile(path.join(OUT, `${p.id}.html`), page(p));

const shops = (await rpc('storefront')).sellers;
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${SITE}/`, pri: '1.0', freq: 'daily' },
  { loc: `${SITE}/seller.html`, pri: '0.8', freq: 'weekly' },
  ...items.map(p => ({ loc: `${SITE}/l/${p.id}.html`, pri: '0.7', freq: 'weekly' }))
];
await fs.writeFile(path.join(ROOT, 'public', 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>\n`);

console.log(`${items.length} listing pages, ${shops.length} shops, sitemap with ${urls.length} urls`);

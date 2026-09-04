/* Turning a phone photograph into what the storefront actually serves.
 *
 * A seller's camera roll image is routinely 4 MB. Uploading that and resizing
 * later means paying for the 4 MB in bandwidth twice and showing it to buyers
 * once. So the resize happens here, in the seller's own browser, before a byte
 * moves — three WebP variants, and the original is never uploaded at all.
 *
 * Variants match how the buyer app renders:
 *   thumb  400w   grid tiles, bag lines
 *   card   800w   the swipe card
 *   full  1600w   the product gallery
 */

const VARIANTS = [
  { name: 'thumb', width: 400, quality: 0.72 },
  { name: 'card', width: 800, quality: 0.78 },
  { name: 'full', width: 1600, quality: 0.82 }
];

/* Random, never sequential. Photo positions change when a seller reorders them,
   and `1-card.webp` written for a different photograph silently overwrites one
   that is still on a live listing. */
const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

async function toBitmap(file) {
  // createImageBitmap applies EXIF orientation, which matters: phone portraits
  // arrive rotated and a sideways product photo looks like a broken listing.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Safari has been late to the options argument. Fall back to an <img>,
    // which the browser orients for us on decode.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function render(source, width, quality) {
  const sw = source.width, sh = source.height;
  // Never upscale: a small photo blown up to 1600w is just a bigger blur that
  // costs more to serve.
  const w = Math.min(width, sw);
  const h = Math.round(w * (sh / sw));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve({ blob, width: w, height: h }) : reject(new Error('could not encode the image'))),
      'image/webp',
      quality
    );
  });
}

/* Returns { id, variants: { thumb|card|full: {blob,width,height} }, preview } */
export async function prepare(file) {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const source = await toBitmap(file);
  const variants = {};
  for (const v of VARIANTS) variants[v.name] = await render(source, v.width, v.quality);
  source.close?.();
  return {
    id: randomId(),
    variants,
    preview: URL.createObjectURL(variants.thumb.blob),
    original: { bytes: file.size, name: file.name }
  };
}

/* One `photos` row per photograph, keyed WITHOUT the variant suffix — the three
   files are an implementation detail of how it is served, not three photos. The
   buyer app appends the variant it wants; deletes expand it back out, because
   Storage removes exact object names and not prefixes. */
export const baseKey = (sellerId, productId, photoId) => `${sellerId}/${productId}/${photoId}`;

export const objectName = (base, variant) => `${base}-${variant}.webp`;

export const objectNames = base => VARIANTS.map(v => objectName(base, v.name));

export const VARIANT_NAMES = VARIANTS.map(v => v.name);

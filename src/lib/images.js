import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

// Each upload is re-encoded into these WebP variants; the original file is never kept or served.
export const VARIANTS = {
  sm: { box: 240, quality: 72 }, // thumbnails (gallery, cart, back-office)
  md: { box: 800, quality: 80 }, // product cards and product page
  lg: { box: 1600, quality: 82 }, // zoom, Open Graph, structured data
};
export const MAX_IMAGES_PER_PRODUCT = 10;
const MAX_INPUT_PIXELS = 50_000_000; // ~ 8000 × 6000: refuses decompression bombs

const SIGNATURES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

// Trust the file's bytes, never its name or declared MIME type.
export function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;
}

export class ImageError extends Error {}

export const variantUrl = (key, size) => `/uploads/${key}-${size}.webp`;
// Small variant of a cover URL (products.image_path), for thumbnails; legacy paths are returned unchanged.
export const thumbUrl = (path) => path.replace(/-md\.webp$/, '-sm.webp');

// Same arithmetic as sharp's fit: 'inside' + withoutEnlargement, so templates can emit exact width/height.
export function variantSize(width, height, size) {
  const scale = Math.min(1, VARIANTS[size].box / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function processImage(buffer, uploadDir) {
  if (!detectImageType(buffer)) throw new ImageError('Format d’image non supporté (JPG, PNG ou WebP uniquement).');
  const key = randomUUID();
  // rotate() applies the EXIF orientation; re-encoding drops all metadata (EXIF, GPS, camera serial…).
  const source = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  let meta;
  try {
    const info = await source.metadata();
    // autoOrient gives the dimensions once the EXIF rotation is applied (portrait phone photos).
    meta = { width: info.autoOrient?.width ?? info.width, height: info.autoOrient?.height ?? info.height };
    await Promise.all(
      Object.entries(VARIANTS).map(([size, { box, quality }]) =>
        source
          .clone()
          .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toFile(join(uploadDir, `${key}-${size}.webp`)),
      ),
    );
  } catch (err) {
    removeImageFiles(uploadDir, key);
    if (err instanceof ImageError) throw err;
    throw new ImageError('Image illisible ou trop grande.');
  }
  return { key, ...meta };
}

export function removeImageFiles(uploadDir, key) {
  if (!/^[0-9a-f-]{36}$/.test(key)) return;
  for (const size of Object.keys(VARIANTS)) rmSync(join(uploadDir, `${key}-${size}.webp`), { force: true });
}

export function listProductImages(db, productId) {
  return db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id').all(productId);
}

// products.image_path mirrors the cover photo. A product without gallery photos keeps a legacy
// single upload (pre-gallery /uploads/<uuid>.<ext>) if it has one.
export function syncCover(db, productId) {
  const cover = db.prepare('SELECT file_key FROM product_images WHERE product_id = ? ORDER BY position, id LIMIT 1').get(productId);
  if (cover) {
    db.prepare('UPDATE products SET image_path = ? WHERE id = ?').run(variantUrl(cover.file_key, 'md'), productId);
  } else {
    db.prepare("UPDATE products SET image_path = '' WHERE id = ? AND image_path LIKE '%-md.webp'").run(productId);
  }
}

// Gallery for templates: every photo with its variant URLs and exact sizes.
export function galleryFor(db, product) {
  const images = listProductImages(db, product.id).map((img) => ({
    id: img.id,
    alt: img.alt,
    ...Object.fromEntries(Object.keys(VARIANTS).map((size) => [size, { url: variantUrl(img.file_key, size), ...variantSize(img.width, img.height, size) }])),
  }));
  if (!images.length && product.image_path) {
    // Legacy single photo: one size only.
    const legacy = { url: product.image_path, width: 630, height: 880 };
    images.push({ id: 0, alt: '', sm: legacy, md: legacy, lg: legacy, legacy: true });
  }
  return images;
}

// Converts a pre-gallery single upload (/uploads/<uuid>.<ext>) into a gallery photo. Returns false if there is none.
export async function importLegacyImage(db, uploadDir, product) {
  const match = /^\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/.exec(product.image_path ?? '');
  if (!match) return false;
  const legacyFile = join(uploadDir, match[1]);
  let buffer;
  try {
    buffer = readFileSync(legacyFile);
  } catch {
    return false;
  }
  const img = await processImage(buffer, uploadDir);
  db.transaction(() => {
    db.prepare('UPDATE product_images SET position = position + 1 WHERE product_id = ?').run(product.id);
    db.prepare('INSERT INTO product_images (product_id, file_key, position, width, height, created_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(product.id, img.key, img.width, img.height, Date.now());
    syncCover(db, product.id);
  })();
  rmSync(legacyFile, { force: true });
  return true;
}

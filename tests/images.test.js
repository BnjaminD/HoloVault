import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { MAX_IMAGES_PER_PRODUCT, processImage, variantSize } from '../src/lib/images.js';
import { addProduct, addUser, csrf, login, request, setup } from './helpers.js';

const photo = (width, height, background = '#3ddc97') => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
const jsonLdOf = (html) => [...html.matchAll(/<script type="application\/ld\+json" nonce="[^"]+">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));

describe('traitement des images', () => {
  it('3 variantes WebP aux dimensions annoncées, sans agrandissement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hv-img-'));
    const img = await processImage(await photo(2000, 2800), dir);
    assert.deepEqual([img.width, img.height], [2000, 2800]);
    for (const size of ['sm', 'md', 'lg']) {
      const meta = await sharp(join(dir, `${img.key}-${size}.webp`)).metadata();
      assert.equal(meta.format, 'webp');
      assert.deepEqual([meta.width, meta.height], Object.values(variantSize(img.width, img.height, size)), size);
    }
    const small = await processImage(await photo(300, 400), dir);
    const lg = await sharp(join(dir, `${small.key}-lg.webp`)).metadata();
    assert.deepEqual([lg.width, lg.height], [300, 400], 'une petite photo n’est pas agrandie');
  });

  it('applique l’orientation EXIF puis supprime toutes les métadonnées (GPS, appareil)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hv-img-'));
    // Landscape pixels tagged "rotate 90°" + EXIF identifying the camera, as a phone would produce.
    const input = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#fff' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: 'PhoneMaker', Model: 'Secret Model' } })
      .toBuffer();
    const source = await sharp(input).metadata();
    assert.equal(source.orientation, 6, 'précondition : l’entrée porte bien l’EXIF');
    const img = await processImage(input, dir);
    assert.deepEqual([img.width, img.height], [800, 1200], 'photo remise en portrait');
    const meta = await sharp(join(dir, `${img.key}-lg.webp`)).metadata();
    assert.deepEqual([meta.width, meta.height], [800, 1200]);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.orientation, undefined);
  });
});

describe('galerie produit', () => {
  async function adminAgent(ctx) {
    const admin = await addUser(ctx.db, { email: 'admin@example.com', role: 'admin' });
    const agent = request.agent(ctx.app);
    await login(agent, admin);
    return agent;
  }
  const fields = { game: 'pokemon', category: 'single', condition: 'mint', language: 'FR', price: '10', stock: '1', active: 'on' };

  async function post(agent, path, values, files = []) {
    const token = await csrf(agent, '/admin/produits/nouveau');
    let req = agent.post(path).field('_csrf', token).field({ ...fields, ...values });
    for (const [i, buf] of files.entries()) req = req.attach('images', buf, `photo-${i}.jpg`);
    return req;
  }
  const imagesOf = (db, id) => db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position').all(id);

  it('création avec 3 photos : couverture, vignettes, zoom, JSON-LD et Open Graph', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const res = await post(admin, '/admin/produits', { name: 'Lugia V' }, [await photo(630, 880, '#f00'), await photo(630, 880, '#0f0'), await photo(630, 880, '#00f')]);
    assert.equal(res.status, 302);
    const product = ctx.db.prepare("SELECT * FROM products WHERE slug = 'lugia-v'").get();
    const images = imagesOf(ctx.db, product.id);
    assert.equal(images.length, 3);
    assert.equal(product.image_path, `/uploads/${images[0].file_key}-md.webp`);

    const page = (await request(ctx.app).get('/produit/lugia-v')).text;
    assert.equal((page.match(/data-thumb /g) ?? []).length, 3);
    assert.match(page, new RegExp(`href="/uploads/${images[0].file_key}-lg\\.webp" data-zoom`));
    assert.match(page, /alt="Lugia V — photo 2"/);
    assert.match(page, new RegExp(`<meta property="og:image" content="http://127\\.0\\.0\\.1/uploads/${images[0].file_key}-lg\\.webp">`));
    assert.equal(jsonLdOf(page)[0].image.length, 3);
  });

  it('modification : choix de la couverture, légende, suppression (fichiers effacés)', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    await post(admin, '/admin/produits', { name: 'Mew' }, [await photo(100, 140), await photo(100, 140), await photo(100, 140)]);
    const { id } = ctx.db.prepare("SELECT id FROM products WHERE slug = 'mew'").get();
    const [a, b, c] = imagesOf(ctx.db, id);

    const res = await post(admin, `/admin/produits/${id}`, { name: 'Mew', cover: String(c.id), [`alt_${c.id}`]: 'Verso', [`remove_${b.id}`]: 'on' });
    assert.equal(res.status, 302);
    const after = imagesOf(ctx.db, id);
    assert.deepEqual(after.map((img) => img.id), [c.id, a.id]);
    assert.equal(after[0].alt, 'Verso');
    assert.equal(ctx.db.prepare('SELECT image_path FROM products WHERE id = ?').get(id).image_path, `/uploads/${c.file_key}-md.webp`);
    assert.ok(!existsSync(join(ctx.config.uploadDir, `${b.file_key}-lg.webp`)), 'fichiers de la photo supprimée effacés');
    assert.ok(existsSync(join(ctx.config.uploadDir, `${a.file_key}-lg.webp`)));
  });

  it(`refuse plus de ${MAX_IMAGES_PER_PRODUCT} photos par produit`, async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const many = await Promise.all(Array.from({ length: MAX_IMAGES_PER_PRODUCT }, () => photo(50, 70)));
    await post(admin, '/admin/produits', { name: 'Pikachu' }, many);
    const { id } = ctx.db.prepare("SELECT id FROM products WHERE slug = 'pikachu'").get();
    const before = readdirSync(ctx.config.uploadDir).length;
    const res = await post(admin, `/admin/produits/${id}`, { name: 'Pikachu' }, [await photo(50, 70)]);
    assert.equal(res.status, 400);
    assert.equal(imagesOf(ctx.db, id).length, MAX_IMAGES_PER_PRODUCT);
    assert.equal(readdirSync(ctx.config.uploadDir).length, before, 'aucun fichier orphelin');
  });

  it('ancienne photo unique : affichée telle quelle, puis convertie à l’enregistrement', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const p = addProduct(ctx.db, { slug: 'ancien', name: 'Ancien' });
    const legacy = '0b5f7c3e-1111-4222-8333-944455556666.jpg';
    writeFileSync(join(ctx.config.uploadDir, legacy), await photo(400, 560));
    ctx.db.prepare('UPDATE products SET image_path = ? WHERE id = ?').run(`/uploads/${legacy}`, p.id);

    assert.match((await request(ctx.app).get('/produit/ancien')).text, new RegExp(`src="/uploads/${legacy}"`));

    await post(admin, `/admin/produits/${p.id}`, { name: 'Ancien' });
    const images = imagesOf(ctx.db, p.id);
    assert.equal(images.length, 1);
    assert.ok(!existsSync(join(ctx.config.uploadDir, legacy)), 'original supprimé');
    assert.equal(ctx.db.prepare('SELECT image_path FROM products WHERE id = ?').get(p.id).image_path, `/uploads/${images[0].file_key}-md.webp`);
  });

  it('produit sans photo : visuel illustré, pas de galerie', async () => {
    const ctx = setup();
    const p = addProduct(ctx.db, { slug: 'sans-photo' });
    const page = (await request(ctx.app).get(`/produit/${p.slug}`)).text;
    assert.doesNotMatch(page, /data-gallery/);
    assert.match(page, /class="art-frame"/);
  });
});

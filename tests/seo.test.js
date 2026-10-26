import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addProduct, request, setup } from './helpers.js';

const canonicalOf = (html) => html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
const robotsOf = (html) => html.match(/<meta name="robots" content="([^"]+)">/)?.[1];
const jsonLdOf = (html) => [...html.matchAll(/<script type="application\/ld\+json" nonce="[^"]+">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));

describe('SEO', () => {
  it('robots.txt déclare le sitemap', async () => {
    const { app } = setup();
    const res = await request(app).get('/robots.txt');
    assert.match(res.text, /^Sitemap: http:\/\/127\.0\.0\.1\/sitemap\.xml$/m);
    assert.match(res.text, /^Disallow: \/admin$/m);
  });

  it('sitemap.xml liste les produits actifs, les pages par jeu et les pages légales', async () => {
    const { app, db } = setup();
    const visible = addProduct(db, { slug: 'visible' });
    const hidden = addProduct(db, { slug: 'archivee' });
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(hidden.id);
    const res = await request(app).get('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/xml/);
    assert.match(res.text, new RegExp(`<loc>http://127\\.0\\.0\\.1/produit/${visible.slug}</loc>`));
    assert.doesNotMatch(res.text, /archivee/);
    assert.match(res.text, /<loc>http:\/\/127\.0\.0\.1\/boutique\/lorcana<\/loc>/);
    assert.match(res.text, /<loc>http:\/\/127\.0\.0\.1\/cgv<\/loc>/);
  });

  it('fiche produit : canonical, description, Open Graph et JSON-LD Product', async () => {
    const { app, db } = setup();
    const p = addProduct(db, { slug: 'dracaufeu', name: 'Dracaufeu', price: 12990, stock: 2 });
    const res = await request(app).get(`/produit/${p.slug}`);
    assert.equal(canonicalOf(res.text), 'http://127.0.0.1/produit/dracaufeu');
    assert.equal(robotsOf(res.text), 'index,follow');
    assert.match(res.text, /<meta name="description" content="Dracaufeu — Pokémon[^"]*129,90/);
    assert.match(res.text, /<meta property="og:type" content="product">/);
    const [product, breadcrumb] = jsonLdOf(res.text);
    assert.equal(product['@type'], 'Product');
    assert.equal(product.offers.price, '129.90');
    assert.equal(product.offers.priceCurrency, 'EUR');
    assert.equal(product.offers.availability, 'https://schema.org/InStock');
    assert.equal(breadcrumb['@type'], 'BreadcrumbList');
    assert.equal(breadcrumb.itemListElement[1].item, 'http://127.0.0.1/boutique/pokemon');
  });

  it('JSON-LD : un nom de produit ne peut pas fermer la balise script', async () => {
    const { app, db } = setup();
    const p = addProduct(db, { slug: 'xss', name: '</script><script>alert(1)</script>' });
    const res = await request(app).get(`/produit/${p.slug}`);
    assert.doesNotMatch(res.text, /<script>alert\(1\)/);
    assert.equal(jsonLdOf(res.text)[0].name, '</script><script>alert(1)</script>');
  });

  it('épuisé → OutOfStock', async () => {
    const { app, db } = setup();
    const p = addProduct(db, { stock: 0 });
    const res = await request(app).get(`/produit/${p.slug}`);
    assert.equal(jsonLdOf(res.text)[0].offers.availability, 'https://schema.org/OutOfStock');
  });

  it('ancienne URL /boutique?game= redirigée en 301 vers la page du jeu', async () => {
    const { app } = setup();
    let res = await request(app).get('/boutique?game=magic');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/boutique/magic');
    res = await request(app).get('/boutique?game=magic&page=2');
    assert.equal(res.headers.location, '/boutique/magic?page=2');
    res = await request(app).get('/boutique?game=magic&sort=price_asc');
    assert.equal(res.status, 200, 'une liste filtrée n’est pas redirigée');
  });

  it('page par jeu indexable, variantes filtrées en noindex', async () => {
    const { app, db } = setup();
    addProduct(db);
    let res = await request(app).get('/boutique/pokemon');
    assert.equal(res.status, 200);
    assert.match(res.text, /<h1>Cartes Pokémon<\/h1>/);
    assert.equal(canonicalOf(res.text), 'http://127.0.0.1/boutique/pokemon');
    assert.equal(robotsOf(res.text), 'index,follow');
    res = await request(app).get('/boutique/pokemon?sort=price_asc&inStock=1');
    assert.equal(robotsOf(res.text), 'noindex,follow');
    assert.equal(canonicalOf(res.text), 'http://127.0.0.1/boutique/pokemon');
    assert.equal((await request(app).get('/boutique/inconnu')).status, 404);
  });

  it('pagination : liens propres et fenêtre réduite', async () => {
    const { app, db } = setup();
    for (let i = 0; i < 12 * 9; i++) addProduct(db);
    const res = await request(app).get('/boutique/pokemon?page=5');
    assert.equal(canonicalOf(res.text), 'http://127.0.0.1/boutique/pokemon?page=5');
    assert.match(res.text, /<title>Cartes Pokémon — page 5/);
    assert.match(res.text, /href="\/boutique\/pokemon"/);
    assert.match(res.text, /href="\/boutique\/pokemon\?page=9"/);
    assert.doesNotMatch(res.text, /href="\/boutique\/pokemon\?page=2"/);
  });

  it('pages privées et erreurs : noindex, sans canonical', async () => {
    const { app } = setup();
    for (const path of ['/connexion', '/panier', '/page-qui-n-existe-pas']) {
      const res = await request(app).get(path);
      assert.equal(robotsOf(res.text), 'noindex,nofollow', path);
      assert.equal(canonicalOf(res.text), undefined, path);
    }
  });
});

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { describe, it } from 'node:test';
import { addProduct, addUser, checkout, csrf, login, request, setup } from './helpers.js';
import { detectImageType } from '../src/routes/admin.js';
import { safeRedirectPath } from '../src/lib/security.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const REAL_PNG = await sharp({ create: { width: 63, height: 88, channels: 3, background: '#8b6cff' } }).png().toBuffer();

async function adminAgent(ctx) {
  const admin = await addUser(ctx.db, { email: 'admin@example.com', role: 'admin' });
  const agent = request.agent(ctx.app);
  await login(agent, admin);
  return agent;
}

describe('en-têtes HTTP', () => {
  it('CSP stricte, anti-clickjacking, nosniff, pas de X-Powered-By', async () => {
    const { app } = setup();
    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('nonce CSP différent à chaque requête', async () => {
    const { app } = setup();
    const nonce = async () => (await request(app).get('/')).headers['content-security-policy'].match(/nonce-([^']+)/)[1];
    assert.notEqual(await nonce(), await nonce());
  });

  it('chaque <script> inline porte le nonce', async () => {
    const { app } = setup();
    const res = await request(app).get('/');
    const nonce = res.headers['content-security-policy'].match(/nonce-([^']+)/)[1];
    for (const tag of res.text.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  });
});

describe('CSRF', () => {
  it('POST sans jeton refusé', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const agent = request.agent(app);
    await agent.get('/connexion');
    const res = await agent.post('/panier').type('form').send({ productId: product.id, quantity: 1 });
    assert.equal(res.status, 403);
  });

  it('jeton d’une autre session refusé', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const stolen = await csrf(request.agent(app));
    const victim = request.agent(app);
    await victim.get('/connexion');
    const res = await victim.post('/panier').type('form').send({ _csrf: stolen, productId: product.id, quantity: 1 });
    assert.equal(res.status, 403);
  });

  it('Origin étrangère refusée même avec un jeton valide', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent.post('/panier').set('Origin', 'https://evil.example').type('form').send({ _csrf: token, productId: product.id, quantity: 1 });
    assert.equal(res.status, 403);
  });

  it('API JSON : jeton exigé (pas de contournement via Content-Type)', async () => {
    const { app } = setup();
    const agent = request.agent(app);
    await agent.get('/connexion');
    for (const type of ['application/json', 'text/plain']) {
      const res = await agent.post('/api/checkout/paypal/order').set('Content-Type', type).send('{}');
      assert.equal(res.status, 403, type);
    }
  });
});

describe('injections', () => {
  for (const q of ["' OR 1=1 --", '%', '_', "\\' UNION SELECT password_hash FROM users --", '"; DROP TABLE products; --']) {
    it(`recherche SQL : ${q}`, async () => {
      const { app, db } = setup();
      await addUser(db);
      addProduct(db, { name: 'Pikachu' });
      const res = await request(app).get('/boutique').query({ q });
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /scrypt\$|Pikachu/);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 1);
    });
  }

  it('filtres et tri hors liste blanche ignorés (pas d’injection dans ORDER BY)', async () => {
    const { app } = setup();
    for (const query of [{ sort: 'price_cents; DROP TABLE users' }, { game: "pokemon' OR '1'='1" }, { page: '-1' }, { minPrice: 'abc' }, { 'q[]': 'x' }]) {
      assert.equal((await request(app).get('/boutique').query(query)).status, 200, JSON.stringify(query));
    }
  });

  it('XSS réfléchi : la recherche est échappée', async () => {
    const { app } = setup();
    const payload = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
    const res = await request(app).get('/boutique').query({ q: payload });
    assert.ok(!res.text.includes('<script>alert(1)'));
    assert.ok(!res.text.includes('<img src=x'));
  });

  it('XSS stocké : nom/adresse saisis à la commande échappés dans l’admin', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const payload = '<img src=x onerror=alert(1)>';
    await checkout(request.agent(ctx.app), addProduct(ctx.db), { extra: { firstName: payload, note: `<script>alert(1)</script>` } });
    const order = ctx.db.prepare('SELECT id FROM orders').get();
    const res = await admin.get(`/admin/commandes/${order.id}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(payload));
    assert.ok(!res.text.includes('<script>alert(1)'));
  });

  it('pollution de prototype via le panier sans effet', async () => {
    const { app } = setup();
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent.post('/panier').set('X-CSRF-Token', token).set('Accept', 'application/json').send({ productId: '__proto__', quantity: 1, __proto__: { admin: true } });
    assert.equal(res.status, 400);
    assert.equal({}.admin, undefined);
  });
});

describe('back-office', () => {
  it('invisible (404) pour un visiteur et pour un client', async () => {
    const { app, db } = setup();
    assert.equal((await request(app).get('/admin')).status, 404);
    const agent = request.agent(app);
    await login(agent, await addUser(db));
    assert.equal((await agent.get('/admin')).status, 404);
    assert.equal((await agent.get('/admin/commandes')).status, 404);
  });

  it('un client ne peut pas changer le statut d’une commande', async () => {
    const ctx = setup();
    await checkout(request.agent(ctx.app), addProduct(ctx.db));
    const order = ctx.db.prepare('SELECT id FROM orders').get();
    const agent = request.agent(ctx.app);
    await login(agent, await addUser(ctx.db));
    const token = await csrf(agent, '/compte');
    await agent.post(`/admin/commandes/${order.id}/statut`).type('form').send({ _csrf: token, status: 'shipped' });
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'paid');
  });

  it('commande annulée : impossible de la rouvrir (pas de double remise en stock)', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const product = addProduct(ctx.db, { stock: 1 });
    await checkout(request.agent(ctx.app), product);
    const order = ctx.db.prepare('SELECT id FROM orders').get();
    const token = await csrf(admin, `/admin/commandes/${order.id}`);
    const setStatus = (status) => admin.post(`/admin/commandes/${order.id}/statut`).type('form').send({ _csrf: token, status });
    await setStatus('cancelled');
    await setStatus('paid');
    await setStatus('cancelled');
    assert.equal(ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock, 1);
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'cancelled');
  });

  it('filtre de statut en tableau (?status=paid&status=paid) : pas d’erreur 500', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    assert.equal((await admin.get('/admin/commandes?status=paid&status=paid')).status, 200);
  });

  it('upload : fichier HTML/PHP déguisé en image refusé, vraie image acceptée', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const token = await csrf(admin, '/admin/produits/nouveau');
    const send = (buffer, filename, contentType) =>
      admin
        .post('/admin/produits')
        .field('_csrf', token)
        .field({ name: `Produit ${filename}`, game: 'pokemon', category: 'single', condition: 'mint', language: 'FR', price: '10', stock: '1', active: 'on' })
        .attach('images', buffer, { filename, contentType });
    const bad = await send(Buffer.from('<?php system($_GET["c"]); ?><script>alert(1)</script>'), 'shell.php.png', 'image/png');
    assert.equal(bad.status, 400);
    const truncated = await send(PNG, 'tronquee.png', 'image/png');
    assert.equal(truncated.status, 400, 'signature PNG valide mais image illisible');
    assert.deepEqual(readdirSync(ctx.config.uploadDir), [], 'rien n’est écrit pour un fichier refusé');
    const ok = await send(REAL_PNG, 'carte.png', 'image/png');
    assert.equal(ok.status, 302);
    const files = readdirSync(ctx.config.uploadDir).sort();
    assert.equal(files.length, 3);
    for (const f of files) assert.match(f, /^[0-9a-f-]{36}-(lg|md|sm)\.webp$/, 'ré-encodé en WebP, nom aléatoire, jamais celui fourni');
  });

  it('upload sans jeton CSRF refusé', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    const res = await admin.post('/admin/produits').field('name', 'x').attach('images', REAL_PNG, 'a.png');
    assert.equal(res.status, 403);
  });
});

describe('fichiers statiques', () => {
  for (const path of ['/static/../.env', '/static/..%2f..%2f.env', '/uploads/..%2f..%2fpackage.json', '/static/%2e%2e/src/config.js', '/uploads/.htaccess']) {
    it(`traversée de répertoire bloquée : ${path}`, async () => {
      const { app } = setup();
      const res = await request(app).get(path);
      assert.notEqual(res.status, 200);
      assert.doesNotMatch(res.text, /SESSION_SECRET|PAYPAL|"dependencies"/);
    });
  }
});

describe('limitation de débit', () => {
  it('brute-force de connexion : 429 après 10 essais', async () => {
    const { app } = setup({ rateLimit: true });
    const agent = request.agent(app);
    const token = await csrf(agent);
    let last;
    for (let i = 0; i < 11; i++) last = await agent.post('/connexion').type('form').send({ _csrf: token, email: 'x@example.com', password: 'y' });
    assert.equal(last.status, 429);
  });
});

describe('fonctions de sécurité', () => {
  it('safeRedirectPath', () => {
    for (const ok of ['/compte', '/produit/lugia-v?x=1', '/admin/commandes/3']) assert.equal(safeRedirectPath(ok), ok);
    for (const bad of ['//evil.com', '/%2F%2Fevil.com', '/%5cevil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/a\r\nLocation: x', '', null, ['/compte'], `/${'a'.repeat(300)}`]) {
      assert.equal(safeRedirectPath(bad, '/'), '/', String(bad));
    }
  });

  it('detectImageType se fie aux octets, pas au nom', () => {
    assert.equal(detectImageType(PNG), 'png');
    assert.equal(detectImageType(Buffer.from('GIF89a<script>alert(1)</script>')), null);
    assert.equal(detectImageType(Buffer.from('<svg onload=alert(1)>xxxxxxxx</svg>')), null);
    assert.equal(detectImageType(Buffer.alloc(4)), null);
  });
});

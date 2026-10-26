import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from '../src/db/index.js';
import { MAX_ATTEMPTS, createMailer } from '../src/lib/mailer.js';
import { addUser, csrf, fakeTransport, login, request, setup } from './helpers.js';

const config = { shopName: 'Test', baseUrl: 'http://127.0.0.1', mailFrom: 'Test <t@example.com>' };
const order = { email: 'client@example.com', first_name: 'Sacha', reference: 'HV-ABC', total_cents: 1000, tracking_number: '', items: [] };
const outbox = (db) => db.prepare('SELECT * FROM email_outbox ORDER BY id').all();

describe('file d’envoi des e-mails', () => {
  it('un e-mail est stocké puis envoyé, et son contenu effacé après envoi', async () => {
    const db = openDb(':memory:');
    const transport = fakeTransport();
    const mailer = createMailer(config, db, { transport });
    assert.equal(mailer.orderConfirmation(order, 'CODE-SECRET-123'), true);
    await mailer.flush();
    assert.equal(transport.sent.length, 1);
    assert.match(transport.sent[0].text, /CODE-SECRET-123/);
    const [row] = outbox(db);
    assert.ok(row.sent_at);
    assert.equal(row.body, '', 'le code d’accès ne reste pas en base');
  });

  it('panne SMTP : l’e-mail est conservé et réessayé plus tard', async () => {
    const db = openDb(':memory:');
    const transport = fakeTransport();
    transport.fail = true;
    const mailer = createMailer(config, db, { transport });
    mailer.orderStatus(order, 'Expédiée');
    await mailer.flush();
    let [row] = outbox(db);
    assert.equal(row.attempts, 1);
    assert.equal(row.sent_at, null);
    assert.ok(row.next_attempt_at > Date.now(), 'nouvel essai différé');

    transport.fail = false;
    await mailer.flush();
    assert.equal(transport.sent.length, 0, 'pas renvoyé avant l’échéance');
    db.prepare('UPDATE email_outbox SET next_attempt_at = 0').run();
    await mailer.flush();
    assert.equal(transport.sent.length, 1);
    [row] = outbox(db);
    assert.ok(row.sent_at);
  });

  it(`abandon après ${MAX_ATTEMPTS} essais, contenu effacé`, async () => {
    const db = openDb(':memory:');
    const transport = fakeTransport();
    transport.fail = true;
    const mailer = createMailer(config, db, { transport });
    mailer.orderConfirmation(order, 'CODE');
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      db.prepare('UPDATE email_outbox SET next_attempt_at = 0').run();
      await mailer.flush();
    }
    const [row] = outbox(db);
    assert.ok(row.failed_at);
    assert.equal(row.body, '');
    assert.match(row.last_error, /SMTP indisponible/);
  });

  it('sans SMTP configuré, les e-mails attendent en file', async () => {
    const db = openDb(':memory:');
    const mailer = createMailer(config, db, { transport: null });
    mailer.stockAlert('a@example.com', { name: 'X', slug: 'x' });
    assert.equal(await mailer.flush(), 0);
    assert.equal(outbox(db)[0].sent_at, null);
  });

  it('les envois concurrents ne doublonnent pas', async () => {
    const db = openDb(':memory:');
    const transport = fakeTransport();
    const mailer = createMailer(config, db, { transport });
    mailer.orderStatus(order, 'Payée');
    await Promise.all([mailer.flush(), mailer.flush(), mailer.flush()]);
    assert.equal(transport.sent.length, 1);
  });

  it('purge des e-mails traités depuis plus de 30 jours', () => {
    const db = openDb(':memory:');
    const mailer = createMailer(config, db, { transport: null });
    mailer.stockAlert('a@example.com', { name: 'X', slug: 'x' });
    mailer.stockAlert('b@example.com', { name: 'X', slug: 'x' });
    db.prepare('UPDATE email_outbox SET sent_at = ? WHERE recipient = ?').run(Date.now() - 31 * 864e5, 'a@example.com');
    assert.equal(mailer.purgeOld(), 1);
    assert.equal(outbox(db).length, 1);
  });
});

describe('back-office : produits', () => {
  async function adminAgent(ctx) {
    const admin = await addUser(ctx.db, { email: 'admin@example.com', role: 'admin' });
    const agent = request.agent(ctx.app);
    await login(agent, admin);
    return agent;
  }

  const fields = { game: 'pokemon', category: 'single', condition: 'mint', language: 'FR', price: '10', active: 'on' };

  async function saveProduct(agent, path, values) {
    const token = await csrf(agent, '/admin/produits/nouveau');
    return agent.post(path).field('_csrf', token).field({ ...fields, ...values });
  }

  it('retour en stock : alertes mises en file puis abonnés retirés, même si le SMTP est en panne', async () => {
    const transport = fakeTransport();
    transport.fail = true;
    const ctx = setup({ mailTransport: transport });
    const admin = await adminAgent(ctx);
    await saveProduct(admin, '/admin/produits', { name: 'Lugia', stock: '0' });
    const { id } = ctx.db.prepare("SELECT id FROM products WHERE name = 'Lugia'").get();
    ctx.db.prepare('INSERT INTO stock_alerts (product_id, email, created_at) VALUES (?, ?, ?)').run(id, 'fan@example.com', Date.now());

    const res = await saveProduct(admin, `/admin/produits/${id}`, { name: 'Lugia', stock: '3' });
    assert.equal(res.status, 302);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_alerts').get().n, 0);
    const queued = ctx.db.prepare("SELECT * FROM email_outbox WHERE recipient = 'fan@example.com'").get();
    assert.ok(queued, 'l’alerte est conservée dans la file');
    assert.match(queued.subject, /Lugia/);
  });

  it('renommer un produit redirige l’ancienne URL en 301 et réserve l’ancien slug', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    await saveProduct(admin, '/admin/produits', { name: 'Dracaufeu', stock: '1' });
    const { id } = ctx.db.prepare("SELECT id FROM products WHERE slug = 'dracaufeu'").get();

    await saveProduct(admin, `/admin/produits/${id}`, { name: 'Dracaufeu Holo', stock: '1' });
    let res = await request(ctx.app).get('/produit/dracaufeu');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/produit/dracaufeu-holo');

    // A new product with the old name must not hijack the redirected URL.
    await saveProduct(admin, '/admin/produits', { name: 'Dracaufeu', stock: '1' });
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE slug = 'dracaufeu'").get().n, 0);
    res = await request(ctx.app).get('/produit/dracaufeu');
    assert.equal(res.headers.location, '/produit/dracaufeu-holo');

    // Renaming back restores the original URL.
    await saveProduct(admin, `/admin/produits/${id}`, { name: 'Dracaufeu', stock: '1' });
    assert.equal((await request(ctx.app).get('/produit/dracaufeu')).status, 200);
    assert.equal((await request(ctx.app).get('/produit/dracaufeu-holo')).headers.location, '/produit/dracaufeu');
  });

  it('produit archivé : l’ancienne URL ne redirige plus', async () => {
    const ctx = setup();
    const admin = await adminAgent(ctx);
    await saveProduct(admin, '/admin/produits', { name: 'Mew', stock: '1' });
    const { id } = ctx.db.prepare("SELECT id FROM products WHERE slug = 'mew'").get();
    await saveProduct(admin, `/admin/produits/${id}`, { name: 'Mew Promo', stock: '1' });
    ctx.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
    assert.equal((await request(ctx.app).get('/produit/mew')).status, 404);
  });
});

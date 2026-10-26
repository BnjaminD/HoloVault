import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addProduct, addUser, checkout, csrf, customer, login, request, setup } from './helpers.js';
import { verifyCapture } from '../src/lib/paypal.js';
import { toPayPalValue } from '../src/lib/catalog.js';

const stock = (db, id) => db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
const lastOrder = (db) => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();

describe('tunnel de commande', () => {
  it('achat invité complet : paiement, stock décrémenté, e-mail avec le numéro', async () => {
    const { app, db, mailer } = setup();
    const product = addProduct(db, { price: 28900, stock: 1 });
    const { captured } = await checkout(request.agent(app), product);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.redirect, '/commande/confirmation');
    const order = lastOrder(db);
    assert.equal(order.status, 'paid');
    assert.equal(order.total_cents, 28900);
    assert.equal(stock(db, product.id), 0);
    assert.equal(mailer.sent[0].type, 'orderConfirmation');
  });

  it('ignore les prix et totaux envoyés par le client', async () => {
    const { app, db } = setup();
    const product = addProduct(db, { price: 50000 });
    const { captured } = await checkout(request.agent(app), product, {
      extra: { price: 1, total: 1, total_cents: 1, subtotal: 1, discount: 49999, shipping: -100, price_cents: 1 },
    });
    assert.equal(captured.status, 200);
    assert.equal(lastOrder(db).total_cents, 50000);
  });

  it('quantité négative, décimale ou énorme dans le panier', async () => {
    const { app, db } = setup();
    const product = addProduct(db, { stock: 3 });
    const agent = request.agent(app);
    const token = await csrf(agent, `/produit/${product.slug}`);
    for (const quantity of [-5, 1.5, 'abc', 1e9]) {
      await agent.post('/panier').type('form').send({ _csrf: token, productId: product.id, quantity, mode: 'set' });
    }
    await agent.post('/panier').type('form').send({ _csrf: token, productId: product.id, quantity: 99, mode: 'set' });
    const res = await agent.post('/api/checkout/paypal/order').set('X-CSRF-Token', token).send(customer);
    assert.equal(res.status, 200);
    assert.ok(lastOrder(db).subtotal_cents <= product.price * 3, 'jamais plus que le stock');
  });

  it('deux acheteurs pour la dernière carte : un seul obtient la réservation', async () => {
    const { app, db } = setup();
    const product = addProduct(db, { stock: 1 });
    const a = request.agent(app);
    const b = request.agent(app);
    const tokenA = await csrf(a, `/produit/${product.slug}`);
    const tokenB = await csrf(b, `/produit/${product.slug}`);
    await a.post('/panier').type('form').send({ _csrf: tokenA, productId: product.id, quantity: 1, mode: 'add' });
    await b.post('/panier').type('form').send({ _csrf: tokenB, productId: product.id, quantity: 1, mode: 'add' });
    const [ra, rb] = await Promise.all([
      a.post('/api/checkout/paypal/order').set('X-CSRF-Token', tokenA).send(customer),
      b.post('/api/checkout/paypal/order').set('X-CSRF-Token', tokenB).send(customer),
    ]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    assert.equal(stock(db, product.id), 0);
  });

  it('impossible de capturer la commande PayPal d’une autre session', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const victim = request.agent(app);
    const { created } = await checkout(victim, product, { capture: false });
    const attacker = request.agent(app);
    const token = await csrf(attacker);
    const res = await attacker.post(`/api/checkout/paypal/order/${created.body.id}/capture`).set('X-CSRF-Token', token).send({});
    assert.equal(res.status, 404);
    assert.equal(lastOrder(db).status, 'pending_payment');
  });

  it('une capture rejouée ne paie pas deux fois', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const agent = request.agent(app);
    const { created, token } = await checkout(agent, product);
    const replay = await agent.post(`/api/checkout/paypal/order/${created.body.id}/capture`).set('X-CSRF-Token', token).send({});
    assert.equal(replay.status, 404);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE status = 'paid'").get().n, 1);
  });

  it('montant capturé différent du total : commande non validée', () => {
    const order = { reference: 'HV-TEST', currency: 'EUR', total_cents: 28900 };
    const capture = (value, currency = 'EUR') => ({
      purchase_units: [{ reference_id: 'HV-TEST', payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: currency, value } }] } }],
    });
    assert.equal(verifyCapture(capture('289.00'), order).ok, true);
    assert.equal(verifyCapture(capture('0.01'), order).ok, false);
    assert.equal(verifyCapture(capture('289.00', 'USD'), order).ok, false);
  });

  it('code promo : appliqué une seule fois au-delà de max_uses', async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO promo_codes (code, percent_off, max_uses) VALUES ('UNEFOIS', 50, 1)").run();
    const first = await checkout(request.agent(app), addProduct(db, { price: 20000 }), { extra: { promoCode: 'unefois' } });
    assert.equal(first.captured.status, 200);
    assert.equal(lastOrder(db).total_cents, 10000);
    const second = await checkout(request.agent(app), addProduct(db, { price: 20000 }), { extra: { promoCode: 'UNEFOIS' } });
    assert.equal(second.created.status, 400);
  });

  it('paiement annulé : stock et code promo restitués', async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO promo_codes (code, percent_off, max_uses) VALUES ('PROMO', 10, 1)").run();
    const product = addProduct(db, { stock: 1 });
    const agent = request.agent(app);
    const { created, token } = await checkout(agent, product, { capture: false, extra: { promoCode: 'PROMO' } });
    assert.equal(stock(db, product.id), 0);
    await agent.post(`/api/checkout/paypal/order/${created.body.id}/cancel`).set('X-CSRF-Token', token).send({});
    assert.equal(stock(db, product.id), 1);
    assert.equal(db.prepare("SELECT uses FROM promo_codes WHERE code = 'PROMO'").get().uses, 0);
  });

  it('devis : entrée invalide → 400, pas 500', async () => {
    const { app } = setup();
    const agent = request.agent(app);
    const token = await csrf(agent);
    const res = await agent.post('/api/panier/devis').set('X-CSRF-Token', token).send({ promoCode: { $ne: 1 } });
    assert.equal(res.status, 400);
  });
});

describe('webhook PayPal', () => {
  it('rejette un webhook non signé (faux « paiement complété »)', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const { created } = await checkout(request.agent(app), product, { capture: false });
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'FAKE', amount: { currency_code: 'EUR', value: '10.00' }, supplementary_data: { related_ids: { order_id: created.body.id } } },
    });
    assert.equal(res.status, 400);
    assert.equal(lastOrder(db).status, 'pending_payment');
  });

  const signedPaypal = (ctx) => ({ ...ctx.paypal, verifyWebhook: async () => true });

  it('paiement reçu après expiration de la commande : signalé pour traitement manuel', async () => {
    const base = setup();
    const ctx = setup({ paypal: signedPaypal(base) });
    const product = addProduct(ctx.db);
    const { created } = await checkout(request.agent(ctx.app), product, { capture: false });
    const order = lastOrder(ctx.db);
    ctx.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    await request(ctx.app).post('/api/paypal/webhook').send({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-LATE', amount: { currency_code: 'EUR', value: toPayPalValue(order.total_cents) }, supplementary_data: { related_ids: { order_id: created.body.id } } },
    });
    const after = lastOrder(ctx.db);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.paypal_capture_id, 'CAP-LATE');
    assert.ok(ctx.db.prepare('SELECT 1 FROM order_events WHERE order_id = ? AND note LIKE ?').get(order.id, '%rembourser%'));
  });

  it('webhook signé mais montant incohérent : non payé', async () => {
    const base = setup();
    const ctx = setup({ paypal: signedPaypal(base) });
    const { created } = await checkout(request.agent(ctx.app), addProduct(ctx.db), { capture: false });
    await request(ctx.app).post('/api/paypal/webhook').send({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP', amount: { currency_code: 'EUR', value: '0.01' }, supplementary_data: { related_ids: { order_id: created.body.id } } },
    });
    assert.equal(lastOrder(ctx.db).status, 'pending_payment');
  });
});

describe('espace client', () => {
  it('IDOR : un client ne voit pas la commande d’un autre', async () => {
    const { app, db } = setup();
    const alice = await addUser(db, { email: 'alice@example.com' });
    const bob = await addUser(db, { email: 'bob@example.com' });
    const a = request.agent(app);
    await login(a, alice);
    await checkout(a, addProduct(db));
    const ref = lastOrder(db).reference;
    assert.equal((await a.get(`/compte/commandes/${ref}`)).status, 200);
    const b = request.agent(app);
    await login(b, bob);
    assert.equal((await b.get(`/compte/commandes/${ref}`)).status, 404);
  });
});

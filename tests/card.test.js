import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addProduct, checkout, csrf, request, setup } from './helpers.js';
import { PayPalError, checkCardAuthentication, createPayPalClient } from '../src/lib/paypal.js';

const stock = (db, id) => db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
const lastOrder = (db) => db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
const card = { paymentMethod: 'card' };

// Mock PayPal client whose 3-D Secure result and capture outcome can be forced.
function cardPaypal({ authentication, capture } = {}) {
  const base = createPayPalClient({ mode: 'mock' }, { shopName: 'Test' });
  const calls = { capture: 0 };
  return {
    calls,
    client: {
      ...base,
      async getOrder(id) {
        const order = await base.getOrder(id);
        if (authentication !== undefined) order.payment_source.card.authentication_result = authentication;
        return order;
      },
      async captureOrder(id) {
        calls.capture++;
        return capture ? capture(id, base) : base.captureOrder(id);
      },
    },
  };
}

describe('checkCardAuthentication (3-D Secure)', () => {
  const order = (auth) => ({ payment_source: { card: { authentication_result: auth } } });
  const tds = (liability_shift, enrollment_status, authentication_status) =>
    order({ liability_shift, three_d_secure: { enrollment_status, authentication_status } });

  it('accepte quand la responsabilité est transférée à la banque', () => {
    assert.equal(checkCardAuthentication(tds('POSSIBLE', 'Y', 'Y')).ok, true);
    assert.equal(checkCardAuthentication(tds('YES', 'Y', 'A')).ok, true);
  });

  it('accepte une carte non enrôlée ou un 3-D Secure indisponible sans échec', () => {
    for (const enrollment of ['N', 'U', 'B']) assert.equal(checkCardAuthentication(tds('NO', enrollment)).ok, true);
  });

  it('refuse les authentifications échouées, rejetées ou inconnues', () => {
    for (const o of [tds('NO', 'Y', 'N'), tds('NO', 'Y', 'R'), tds('UNKNOWN', 'U'), tds('NO', 'Y', 'U'), order(undefined), {}, null]) {
      assert.equal(checkCardAuthentication(o).ok, false, JSON.stringify(o));
    }
  });
});

describe('paiement par carte', () => {
  it('commande payée par carte : statut payé, méthode enregistrée, stock décrémenté', async () => {
    const { app, db } = setup();
    const product = addProduct(db, { price: 12000, stock: 2 });
    const { created, captured } = await checkout(request.agent(app), product, { extra: card });
    assert.equal(created.status, 200);
    assert.equal(captured.status, 200);
    const o = lastOrder(db);
    assert.equal(o.status, 'paid');
    assert.equal(o.payment_method, 'card');
    assert.equal(stock(db, product.id), 1);
  });

  it('par défaut, une commande est payée par compte PayPal', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    await checkout(request.agent(app), product);
    assert.equal(lastOrder(db).payment_method, 'paypal');
  });

  it('refuse un moyen de paiement inconnu', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const { created } = await checkout(request.agent(app), product, { extra: { paymentMethod: 'bitcoin' } });
    assert.equal(created.status, 400);
    assert.equal(lastOrder(db), undefined);
  });

  it('3-D Secure échoué : aucune capture, commande annulée, stock remis', async () => {
    const pp = cardPaypal({ authentication: { liability_shift: 'NO', three_d_secure: { enrollment_status: 'Y', authentication_status: 'N' } } });
    const { app, db } = setup({ paypal: pp.client });
    const product = addProduct(db, { stock: 1 });
    const agent = request.agent(app);
    const { token, created, captured } = await checkout(agent, product, { extra: card });
    assert.equal(captured.status, 422);
    assert.match(captured.body.error, /3-D Secure/);
    assert.equal(pp.calls.capture, 0, 'jamais de capture sans authentification');
    assert.equal(stock(db, product.id), 1);
    assert.notEqual(lastOrder(db).status, 'paid');
    // The session's pending order is gone: replaying the capture is refused.
    const replay = await agent.post(`/api/checkout/paypal/order/${created.body.id}/capture`).set('X-CSRF-Token', token).send({});
    assert.equal(replay.status, 404);
  });

  it('carte refusée à la capture (DECLINED) : commande annulée, stock remis', async () => {
    const pp = cardPaypal({
      capture: async (id, base) => {
        const res = await base.captureOrder(id);
        res.purchase_units[0].payments.captures[0].status = 'DECLINED';
        return res;
      },
    });
    const { app, db } = setup({ paypal: pp.client });
    const product = addProduct(db, { stock: 1 });
    const { captured } = await checkout(request.agent(app), product, { extra: card });
    assert.equal(captured.status, 422);
    assert.match(captured.body.error, /refusée/);
    assert.equal(stock(db, product.id), 1);
    assert.notEqual(lastOrder(db).status, 'paid');
  });

  it('carte refusée par PayPal (UNPROCESSABLE_ENTITY) : commande annulée, stock remis', async () => {
    const pp = cardPaypal({
      capture: async () => {
        throw new PayPalError('declined', { name: 'UNPROCESSABLE_ENTITY' });
      },
    });
    const { app, db } = setup({ paypal: pp.client });
    const product = addProduct(db, { stock: 1 });
    const { captured } = await checkout(request.agent(app), product, { extra: card });
    assert.equal(captured.status, 422);
    assert.equal(captured.body.restart, undefined);
    assert.equal(stock(db, product.id), 1);
  });

  it('page de commande : champs carte et SDK avec le composant card-fields', async () => {
    const { app, db } = setup();
    const product = addProduct(db);
    const agent = request.agent(app);
    const token = await csrf(agent, `/produit/${product.slug}`);
    await agent.post('/panier').type('form').send({ _csrf: token, productId: product.id, quantity: 1, mode: 'add' });
    const page = await agent.get('/commande');
    assert.equal(page.status, 200);
    assert.match(page.text, /id="mock-card-pay"/);
  });
});

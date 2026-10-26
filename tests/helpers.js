import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createMailer } from '../src/lib/mailer.js';
import { createPayPalClient } from '../src/lib/paypal.js';
import { hashSecret, setScryptCost } from '../src/lib/security.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PASSWORD = 'Correct-Horse-Battery-9';

// Records every e-mail instead of sending it.
function fakeMailer() {
  const sent = [];
  return new Proxy({ sent }, {
    get: (target, prop) => (prop in target ? target[prop] : async (...args) => { sent.push({ type: prop, args }); return true; }),
  });
}

// Records what a real mailer hands to SMTP; set `fail` to simulate an outage.
export function fakeTransport() {
  const transport = {
    fail: false,
    sent: [],
    async sendMail(message) {
      if (transport.fail) throw new Error('SMTP indisponible');
      transport.sent.push(message);
    },
  };
  return transport;
}

// `mailTransport`: use the real outbox-backed mailer over that transport instead of the recording fake.
export function setup({ rateLimit = false, paypal, mailTransport } = {}) {
  const config = loadConfig({
    env: 'test',
    databasePath: ':memory:',
    uploadDir: mkdtempSync(join(tmpdir(), 'hv-uploads-')),
    scryptCost: 2 ** 10,
    baseUrl: 'http://127.0.0.1',
    paypal: { mode: 'mock' },
  });
  setScryptCost(config.scryptCost);
  const db = openDb(':memory:');
  const mailer = mailTransport
    ? createMailer({ ...config, shopName: 'Test' }, db, { transport: mailTransport })
    : fakeMailer();
  const pp = paypal ?? createPayPalClient(config.paypal, { shopName: 'Test' });
  const app = createApp({ db, config, paypal: pp, mailer, disableRateLimit: !rateLimit });
  return { app, db, mailer, paypal: pp, config };
}

export function addProduct(db, { name = 'Carte test', price = 1000, stock = 1, slug } = {}) {
  const s = slug ?? `carte-${Math.random().toString(36).slice(2, 8)}`;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO products (slug, name, game, category, price_cents, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s, name, 'pokemon', 'single', price, stock, Date.now());
  return { id: Number(lastInsertRowid), slug: s, price, stock };
}

export async function addUser(db, { email = 'client@example.com', role = 'customer', password = PASSWORD } = {}) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, address_line1, postal_code, city, country, created_at)
       VALUES (?, ?, ?, 'Test', 'User', '0600000000', '1 rue Test', '75001', 'Paris', 'FR', ?)`,
    )
    .run(email, await hashSecret(password), role, Date.now());
  return { id: Number(lastInsertRowid), email, password };
}

// Any page carrying a form gives us the session's CSRF token.
export async function csrf(agent, path = '/connexion') {
  const res = await agent.get(path);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/) ?? res.text.match(/name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error(`Pas de jeton CSRF sur ${path} (statut ${res.status})`);
  return m[1];
}

export async function login(agent, { email, password }) {
  const token = await csrf(agent, '/connexion');
  return agent.post('/connexion').type('form').send({ _csrf: token, email, password });
}

export const customer = {
  email: 'acheteur@example.com',
  firstName: 'Sacha',
  lastName: 'Ketchum',
  phone: '0612345678',
  addressLine1: '12 rue du Bourg Palette',
  postalCode: '75011',
  city: 'Paris',
  country: 'FR',
  shippingMethod: 'colissimo',
  acceptTerms: 'on',
};

// Full guest purchase through the real endpoints; returns the PayPal order id and the HTTP responses.
export async function checkout(agent, product, { quantity = 1, extra = {}, capture = true } = {}) {
  const token = await csrf(agent, `/produit/${product.slug}`);
  await agent.post('/panier').type('form').send({ _csrf: token, productId: product.id, quantity, mode: 'add' });
  const created = await agent.post('/api/checkout/paypal/order').set('X-CSRF-Token', token).send({ ...customer, ...extra });
  if (!capture || created.status !== 200) return { token, created };
  const captured = await agent.post(`/api/checkout/paypal/order/${created.body.id}/capture`).set('X-CSRF-Token', token).send({});
  return { token, created, captured };
}

export { request };

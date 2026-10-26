import { randomUUID } from 'node:crypto';
import { toPayPalValue } from './catalog.js';

const API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export class PayPalError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function buildOrderBody(order, items, shopName, { method = 'paypal' } = {}) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: order.reference,
        custom_id: order.reference,
        invoice_id: order.reference,
        description: `Commande ${order.reference} — ${shopName}`.slice(0, 127),
        amount: {
          currency_code: order.currency,
          value: toPayPalValue(order.total_cents),
          breakdown: {
            item_total: { currency_code: order.currency, value: toPayPalValue(order.subtotal_cents) },
            shipping: { currency_code: order.currency, value: toPayPalValue(order.shipping_cents) },
            discount: { currency_code: order.currency, value: toPayPalValue(order.discount_cents) },
          },
        },
        items: items.map((i) => ({
          name: i.name.slice(0, 127),
          quantity: String(i.quantity),
          unit_amount: { currency_code: order.currency, value: toPayPalValue(i.unit_price_cents) },
          category: 'PHYSICAL_GOODS',
        })),
      },
    ],
    payment_source:
      method === 'card'
        ? {
            // Card typed in the checkout page (Card Fields): ask for 3-D Secure whenever the bank requires it (SCA, EU).
            card: { attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } } },
          }
        : {
            paypal: {
              experience_context: {
                brand_name: shopName.slice(0, 127),
                locale: 'fr-FR',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
              },
            },
          },
  };
}

// Decides whether a card order may be captured, from its 3-D Secure result (PayPal "recommended actions"):
// capture when the liability shifted to the bank, or when the card is simply not enrolled in 3-D Secure;
// refuse failed, rejected, unavailable or unknown authentications.
export function checkCardAuthentication(paypalOrder) {
  const auth = paypalOrder?.payment_source?.card?.authentication_result;
  if (!auth) return { ok: false, reason: 'no-authentication-result' };
  const liability = auth.liability_shift;
  const enrollment = auth.three_d_secure?.enrollment_status;
  const status = auth.three_d_secure?.authentication_status;
  if (liability === 'POSSIBLE' || liability === 'YES') return { ok: true };
  if (liability === 'NO' && ['N', 'U', 'B'].includes(enrollment) && !status) return { ok: true };
  return { ok: false, reason: `3ds:${liability ?? '?'}/${enrollment ?? '?'}/${status ?? '?'}` };
}

// Extracts what we need from a capture response and checks it against the expected order.
export function verifyCapture(capture, order) {
  const unit = capture?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (cap?.status === 'DECLINED') return { ok: false, declined: true, reason: 'declined', captureId: cap.id };
  if (!cap || !['COMPLETED', 'PENDING'].includes(cap.status)) return { ok: false, reason: 'status' };
  if (unit.reference_id && unit.reference_id !== order.reference) return { ok: false, reason: 'reference', captureId: cap.id };
  if (cap.amount?.currency_code !== order.currency || cap.amount?.value !== toPayPalValue(order.total_cents)) {
    return { ok: false, reason: 'amount', captureId: cap.id };
  }
  // PENDING = PayPal is reviewing the payment; the final outcome arrives by webhook.
  return { ok: true, pending: cap.status === 'PENDING', captureId: cap.id };
}

export function createPayPalClient({ mode, clientId, clientSecret, webhookId }, { shopName, fetchImpl = fetch } = {}) {
  if (mode === 'mock') return createMockClient(shopName);
  const base = API_BASE[mode];
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new PayPalError('Authentification PayPal impossible', { status: res.status });
    const data = await res.json();
    token = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function call(method, path, body, extraHeaders = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(`Erreur PayPal (${res.status})`, { status: res.status, name: data?.name, debugId: data?.debug_id });
    return data;
  }

  return {
    mode,
    clientId,
    async createOrder(order, items, { method = 'paypal' } = {}) {
      const data = await call('POST', '/v2/checkout/orders', buildOrderBody(order, items, shopName, { method }), {
        'PayPal-Request-Id': `create-${order.reference}`,
      });
      return data.id;
    },
    getOrder(paypalOrderId) {
      return call('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
    },
    captureOrder(paypalOrderId) {
      return call('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, undefined, {
        'PayPal-Request-Id': `capture-${paypalOrderId}`,
        Prefer: 'return=representation',
      });
    },
    async verifyWebhook(headers, event) {
      if (!webhookId) return false;
      const data = await call('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return data.verification_status === 'SUCCESS';
    },
  };
}

// Development-only simulator: never enabled in production (enforced in config.js).
// A card payment is simulated as successfully authenticated with 3-D Secure.
function createMockClient(shopName) {
  const orders = new Map();
  return {
    mode: 'mock',
    clientId: '',
    async createOrder(order, items, { method = 'paypal' } = {}) {
      const body = buildOrderBody(order, items, shopName, { method });
      const id = `MOCK-${randomUUID()}`;
      orders.set(id, { ...body.purchase_units[0], method });
      return id;
    },
    async getOrder(id) {
      const unit = orders.get(id);
      if (!unit) throw new PayPalError('Commande PayPal inconnue', { status: 404 });
      return {
        id,
        status: 'APPROVED',
        payment_source:
          unit.method === 'card'
            ? { card: { last_digits: '4242', authentication_result: { liability_shift: 'POSSIBLE', three_d_secure: { enrollment_status: 'Y', authentication_status: 'Y' } } } }
            : { paypal: {} },
      };
    },
    async captureOrder(id) {
      const unit = orders.get(id);
      if (!unit) throw new PayPalError('Commande PayPal inconnue', { status: 404 });
      orders.delete(id);
      return {
        id,
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: unit.reference_id,
            payments: {
              captures: [{ id: `CAP-${randomUUID()}`, status: 'COMPLETED', custom_id: unit.custom_id, amount: unit.amount }],
            },
          },
        ],
      };
    },
    async verifyWebhook() {
      return false;
    },
  };
}

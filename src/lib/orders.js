import { hashSecret, newAccessCode, newOrderReference } from './security.js';

export class CheckoutError extends Error {}

export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000;

export function addOrderEvent(db, orderId, status, note = '') {
  db.prepare('INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)').run(
    orderId,
    status,
    note,
    Date.now(),
  );
}

// Reserves stock and creates the order in a single transaction; returns the plaintext access code once.
export async function createPendingOrder(db, { lines, quote, customer, userId }) {
  if (!lines.length) throw new CheckoutError('Votre panier est vide');
  const accessCode = newAccessCode();
  const accessCodeHash = await hashSecret(accessCode.replace(/-/g, ''));
  const now = Date.now();

  const insert = db.transaction(() => {
    for (const line of lines) {
      const res = db
        .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND stock >= ?')
        .run(line.quantity, line.product.id, line.quantity);
      if (res.changes !== 1) throw new CheckoutError(`Stock insuffisant pour « ${line.product.name} »`);
    }
    if (quote.promo) {
      const res = db
        .prepare('UPDATE promo_codes SET uses = uses + 1 WHERE code = ? AND active = 1 AND (max_uses IS NULL OR uses < max_uses)')
        .run(quote.promo.code);
      if (res.changes !== 1) throw new CheckoutError('Code promo épuisé');
    }
    let reference;
    do reference = newOrderReference();
    while (db.prepare('SELECT 1 FROM orders WHERE reference = ?').get(reference));

    const { lastInsertRowid: orderId } = db
      .prepare(
        `INSERT INTO orders (reference, access_code_hash, user_id, email, first_name, last_name, phone,
           address_line1, address_line2, postal_code, city, country, shipping_method,
           subtotal_cents, discount_cents, shipping_cents, total_cents, promo_code, customer_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reference, accessCodeHash, userId ?? null, customer.email, customer.firstName, customer.lastName, customer.phone,
        customer.addressLine1, customer.addressLine2 || '', customer.postalCode, customer.city, customer.country,
        quote.shippingMethod, quote.subtotal, quote.discount, quote.shipping, quote.total,
        quote.promo?.code ?? null, customer.note || '', now, now,
      );
    const item = db.prepare(
      'INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)',
    );
    for (const line of lines) item.run(orderId, line.product.id, line.product.name, line.product.price_cents, line.quantity);
    addOrderEvent(db, orderId, 'pending_payment', 'Commande créée');
    return { id: Number(orderId), reference };
  });

  return { ...insert(), accessCode };
}

export function releaseOrder(db, orderId, note = 'Paiement non finalisé') {
  return db.transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'pending_payment'").get(orderId);
    if (!order) return false;
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), orderId);
    for (const item of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
      if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    if (order.promo_code) db.prepare('UPDATE promo_codes SET uses = MAX(uses - 1, 0) WHERE code = ?').run(order.promo_code);
    addOrderEvent(db, orderId, 'cancelled', note);
    return true;
  })();
}

export function releaseExpiredOrders(db) {
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending_payment' AND paypal_capture_id IS NULL AND created_at < ?")
    .all(Date.now() - PENDING_ORDER_TTL_MS);
  for (const { id } of stale) releaseOrder(db, id, 'Délai de paiement expiré');
  return stale.length;
}

// Idempotent: only a pending order transitions to paid.
export function markOrderPaid(db, orderId, captureId) {
  return db.transaction(() => {
    const res = db
      .prepare("UPDATE orders SET status = 'paid', paypal_capture_id = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment'")
      .run(captureId, Date.now(), Date.now(), orderId);
    if (res.changes === 1) addOrderEvent(db, orderId, 'paid', 'Paiement PayPal confirmé');
    return res.changes === 1;
  })();
}

export function getOrderWithItems(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  order.events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);
  return order;
}

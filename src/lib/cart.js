import { FREE_SHIPPING_THRESHOLD_CENTS, MAX_CART_LINES, MAX_QTY_PER_LINE, SHIPPING_METHODS } from './catalog.js';

// The session cart only stores { productId: quantity }; prices always come from the database.
export function getCart(req) {
  if (!req.session.cart || typeof req.session.cart !== 'object') req.session.cart = {};
  return req.session.cart;
}

export function cartCount(req) {
  return Object.values(req.session?.cart || {}).reduce((sum, q) => sum + q, 0);
}

export function setCartQuantity(db, req, productId, quantity) {
  const cart = getCart(req);
  const product = db.prepare('SELECT id, stock FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product || quantity <= 0) {
    delete cart[productId];
    return { ok: !!product || quantity <= 0, quantity: 0 };
  }
  if (!cart[productId] && Object.keys(cart).length >= MAX_CART_LINES) return { ok: false, error: 'Panier plein' };
  const clamped = Math.min(quantity, MAX_QTY_PER_LINE, product.stock);
  if (clamped <= 0) {
    delete cart[productId];
    return { ok: false, error: 'Produit en rupture de stock' };
  }
  cart[productId] = clamped;
  return { ok: true, quantity: clamped, clamped: clamped < quantity };
}

// Resolves the cart against current prices/stock and drops anything no longer purchasable.
export function loadCartLines(db, req) {
  const cart = getCart(req);
  const ids = Object.keys(cart).map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT * FROM products WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = [];
  for (const id of ids) {
    const product = byId.get(id);
    const quantity = Math.min(cart[id], product?.stock ?? 0, MAX_QTY_PER_LINE);
    if (!product || quantity <= 0) {
      delete cart[id];
      continue;
    }
    cart[id] = quantity;
    lines.push({ product, quantity, lineCents: product.price_cents * quantity });
  }
  return lines;
}

export function findPromo(db, code) {
  if (!code) return null;
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND active = 1').get(code);
  if (!promo) return null;
  if (promo.expires_at && promo.expires_at < Date.now()) return null;
  if (promo.max_uses != null && promo.uses >= promo.max_uses) return null;
  return promo;
}

export function computeQuote(db, lines, { shippingMethod = 'colissimo', promoCode = '' } = {}) {
  const subtotal = lines.reduce((sum, l) => sum + l.lineCents, 0);
  const promo = findPromo(db, promoCode);
  const discount = promo ? Math.floor((subtotal * promo.percent_off) / 100) : 0;
  const method = SHIPPING_METHODS[shippingMethod] ? shippingMethod : 'colissimo';
  const afterDiscount = subtotal - discount;
  const freeShipping = method !== 'express' && afterDiscount >= FREE_SHIPPING_THRESHOLD_CENTS;
  const shipping = lines.length === 0 || freeShipping ? 0 : SHIPPING_METHODS[method].cents;
  return {
    subtotal,
    discount,
    shipping,
    total: afterDiscount + shipping,
    shippingMethod: method,
    promo: promo ? { code: promo.code, percent: promo.percent_off } : null,
    promoError: promoCode && !promo ? 'Code promo invalide ou expiré' : null,
    freeShippingRemaining: Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - afterDiscount),
  };
}

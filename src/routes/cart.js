import { Router } from 'express';
import { cartCount, computeQuote, loadCartLines, setCartQuantity } from '../lib/cart.js';
import { cartUpdateSchema, quoteSchema } from '../lib/validation.js';
import { flash } from '../middleware.js';

export function cartRoutes({ db }) {
  const router = Router();

  router.get('/panier', (req, res) => {
    const lines = loadCartLines(db, req);
    const quote = computeQuote(db, lines, { shippingMethod: req.session.shippingMethod });
    res.render('cart', { title: 'Panier', lines, quote });
  });

  // mode=add increments, mode=set replaces the quantity.
  router.post('/panier', (req, res) => {
    const parsed = cartUpdateSchema.safeParse(req.body);
    const json = req.get('accept')?.includes('application/json');
    if (!parsed.success) {
      if (json) return res.status(400).json({ error: 'Requête invalide' });
      flash(req, 'error', 'Requête invalide.');
      return res.redirect('/panier');
    }
    const { productId, quantity } = parsed.data;
    const current = req.session.cart?.[productId] ?? 0;
    const target = req.body.mode === 'add' ? current + Math.max(1, quantity) : quantity;
    const result = setCartQuantity(db, req, productId, target);

    if (json) return res.status(result.ok ? 200 : 409).json({ ...result, cartCount: cartCount(req) });
    if (!result.ok) flash(req, 'error', result.error || 'Produit indisponible.');
    else if (result.clamped) flash(req, 'info', 'Quantité ajustée au stock disponible.');
    else if (req.body.mode === 'add') flash(req, 'success', 'Ajouté au panier.');
    res.redirect('/panier');
  });

  router.post('/api/panier/devis', (req, res) => {
    const parsed = quoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Requête invalide' });
    const opts = parsed.data;
    req.session.shippingMethod = opts.shippingMethod;
    const lines = loadCartLines(db, req);
    res.json(computeQuote(db, lines, opts));
  });

  return router;
}

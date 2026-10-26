import { Router } from 'express';
import { flash, requireAuth } from '../middleware.js';
import { shopQuerySchema, stockAlertSchema } from '../lib/validation.js';

const PAGE_SIZE = 12;

export function shopRoutes({ db, limiters }) {
  const router = Router();

  router.get('/', (req, res) => {
    const featured = db.prepare('SELECT * FROM products WHERE active = 1 AND is_featured = 1 ORDER BY price_cents DESC LIMIT 8').all();
    const latest = db.prepare('SELECT * FROM products WHERE active = 1 AND stock > 0 ORDER BY created_at DESC, id DESC LIMIT 8').all();
    const gameCounts = Object.fromEntries(
      db.prepare('SELECT game, COUNT(*) AS n FROM products WHERE active = 1 GROUP BY game').all().map((r) => [r.game, r.n]),
    );
    res.render('home', { title: 'Cartes rares & collection', featured, latest, gameCounts });
  });

  router.get('/boutique', (req, res) => {
    const f = shopQuerySchema.parse(req.query);
    const where = ['active = 1'];
    const params = [];
    if (f.q) {
      where.push("(name LIKE ? ESCAPE '\\' OR set_name LIKE ? ESCAPE '\\' OR card_number LIKE ? ESCAPE '\\')");
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like);
    }
    for (const key of ['game', 'category', 'condition']) {
      if (f[key]) {
        where.push(`${key} = ?`);
        params.push(f[key]);
      }
    }
    if (f.minPrice != null) {
      where.push('price_cents >= ?');
      params.push(Math.round(f.minPrice * 100));
    }
    if (f.maxPrice != null) {
      where.push('price_cents <= ?');
      params.push(Math.round(f.maxPrice * 100));
    }
    if (f.inStock) where.push('stock > 0');
    const order = {
      new: 'created_at DESC, id DESC',
      price_asc: 'price_cents ASC',
      price_desc: 'price_cents DESC',
      name: 'name COLLATE NOCASE ASC',
    }[f.sort];

    const whereSql = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${whereSql}`).get(...params).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(f.page, pages);
    const products = db
      .prepare(`SELECT * FROM products WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '' && k !== 'page') query.set(k, String(v));
    res.render('shop', { title: 'Boutique', products, filters: f, total, page, pages, baseQuery: query.toString() });
  });

  router.get('/produit/:slug', (req, res, next) => {
    const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(String(req.params.slug));
    if (!product) return next();
    const related = db
      .prepare('SELECT * FROM products WHERE active = 1 AND game = ? AND id != ? AND stock > 0 ORDER BY RANDOM() LIMIT 4')
      .all(product.game, product.id);
    const inWishlist = res.locals.user
      ? !!db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(res.locals.user.id, product.id)
      : false;
    res.render('product', { title: product.name, product, related, inWishlist });
  });

  router.post('/produit/:slug/alerte', limiters.form, (req, res, next) => {
    const product = db.prepare('SELECT id, slug FROM products WHERE slug = ? AND active = 1').get(String(req.params.slug));
    if (!product) return next();
    const parsed = stockAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      flash(req, 'error', 'Adresse e-mail invalide.');
    } else {
      db.prepare('INSERT OR IGNORE INTO stock_alerts (product_id, email, created_at) VALUES (?, ?, ?)').run(product.id, parsed.data.email, Date.now());
      flash(req, 'success', 'C’est noté ! Nous vous écrirons dès le retour en stock.');
    }
    res.redirect(`/produit/${product.slug}`);
  });

  router.post('/favoris/:id', requireAuth, (req, res) => {
    const productId = Number(req.params.id);
    const product = Number.isInteger(productId) && db.prepare('SELECT id, slug FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    const userId = res.locals.user.id;
    const exists = db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(userId, productId);
    if (exists) db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(userId, productId);
    else db.prepare('INSERT INTO wishlist (user_id, product_id, created_at) VALUES (?, ?, ?)').run(userId, productId, Date.now());
    if (req.get('accept')?.includes('application/json')) return res.json({ inWishlist: !exists });
    res.redirect(req.body?.from === 'account' ? '/compte?onglet=favoris' : `/produit/${product.slug}`);
  });

  return router;
}

import { Router } from 'express';
import { flash, requireAuth } from '../middleware.js';
import { GAMES, formatPrice } from '../lib/catalog.js';
import { galleryFor, thumbUrl } from '../lib/images.js';
import { SORTS, effectiveSort, facets, listingQuery, suggestions } from '../lib/search.js';
import { breadcrumbJsonLd, gamePath, organizationJsonLd, productDescription, productJsonLd } from '../lib/seo.js';
import { shopQuerySchema, stockAlertSchema } from '../lib/validation.js';

const PAGE_SIZE = 12;
// Filters that only narrow or reorder a listing: such pages are crawlable but must not be indexed.
const isRefined = (f) =>
  !!(f.q || f.category || f.condition || f.set || f.lang || f.grader || f.minPrice != null || f.maxPrice != null || f.inStock || (f.sort && f.sort !== 'new'));

export function shopRoutes({ db, config, limiters }) {
  const router = Router();

  router.get('/', (req, res) => {
    const featured = db.prepare('SELECT * FROM products WHERE active = 1 AND is_featured = 1 ORDER BY price_cents DESC LIMIT 8').all();
    const latest = db.prepare('SELECT * FROM products WHERE active = 1 AND stock > 0 ORDER BY created_at DESC, id DESC LIMIT 8').all();
    const gameCounts = Object.fromEntries(
      db.prepare('SELECT game, COUNT(*) AS n FROM products WHERE active = 1 GROUP BY game').all().map((r) => [r.game, r.n]),
    );
    res.render('home', {
      title: 'Cartes rares & collection', featured, latest, gameCounts,
      structuredData: [organizationJsonLd({ baseUrl: config.baseUrl, shopName: config.shopName })],
    });
  });

  // A submitted filter form sends every field, empty ones included (?q=&category=&minPrice=…):
  // redirect to the same listing without them, so URLs stay short, shareable and comparable.
  function dropEmptyParams(req, res, next) {
    const raw = new URL(req.originalUrl, 'http://x').searchParams;
    const kept = new URLSearchParams([...raw].filter(([, v]) => v.trim() !== ''));
    if (kept.size === raw.size) return next();
    res.redirect(302, req.path + (kept.size ? `?${kept}` : ''));
  }
  router.get(['/boutique', '/boutique/:game'], dropEmptyParams);

  // Old filter URL for a whole game → permanent redirect to its dedicated page.
  router.get('/boutique', (req, res, next) => {
    const f = shopQuerySchema.parse(req.query);
    if (!f.game || isRefined(f)) return next();
    res.redirect(301, gamePath(f.game) + (f.page > 1 ? `?page=${f.page}` : ''));
  });

  router.get('/boutique', (req, res) => renderListing(req, res, shopQuerySchema.parse(req.query)));

  router.get('/boutique/:game', (req, res, next) => {
    if (!Object.hasOwn(GAMES, req.params.game)) return next();
    renderListing(req, res, shopQuerySchema.parse({ ...req.query, game: req.params.game }));
  });

  function renderListing(req, res, f) {
    const sort = effectiveSort(f);
    const q = listingQuery(f);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${q.from} WHERE ${q.where}`).get(...q.params).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(f.page, pages);
    const products = db
      .prepare(`SELECT p.* FROM ${q.from} WHERE ${q.where} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`)
      .all(...q.params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    const basePath = f.game ? gamePath(f.game) : '/boutique';
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v == null || v === '' || k === 'page' || (k === 'game' && f.game)) continue;
      query.set(k, String(v));
    }
    const refined = isRefined(f);
    const game = f.game && GAMES[f.game];
    const pageSuffix = page > 1 ? ` — page ${page}` : '';
    res.render('shop', {
      title: (game ? `Cartes ${game.label}` : 'Boutique') + pageSuffix,
      description: game?.intro,
      intro: !refined && page === 1 ? game?.intro : null,
      canonical: refined ? basePath : basePath + (page > 1 ? `?page=${page}` : ''),
      robots: refined ? 'noindex,follow' : null,
      structuredData: game ? [breadcrumbJsonLd(config.baseUrl, [['Accueil', '/'], ['Boutique', '/boutique'], [game.label]])] : [],
      products, filters: f, sort, facets: facets(db, f), total, page, pages, basePath, baseQuery: query.toString(),
    });
  }

  // Header autocomplete (JSON). Public data only; the global rate limiter applies.
  router.get('/api/recherche', (req, res) => {
    const text = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const items = suggestions(db, text).map((p) => ({
      name: p.name,
      url: `/produit/${p.slug}`,
      game: p.game,
      detail: [GAMES[p.game]?.label, p.set_name].filter(Boolean).join(' · '),
      price: formatPrice(p.price_cents),
      inStock: p.stock > 0,
      image: p.image_path ? thumbUrl(p.image_path) : null,
    }));
    res.set('Cache-Control', 'public, max-age=60').json({ items });
  });

  router.get('/produit/:slug', (req, res, next) => {
    const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(String(req.params.slug));
    if (!product) {
      const moved = db
        .prepare('SELECT p.slug FROM product_slug_history h JOIN products p ON p.id = h.product_id WHERE h.slug = ? AND p.active = 1')
        .get(String(req.params.slug));
      return moved ? res.redirect(301, `/produit/${moved.slug}`) : next();
    }
    const related = db
      .prepare('SELECT * FROM products WHERE active = 1 AND game = ? AND id != ? AND stock > 0 ORDER BY RANDOM() LIMIT 4')
      .all(product.game, product.id);
    const inWishlist = res.locals.user
      ? !!db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(res.locals.user.id, product.id)
      : false;
    const game = GAMES[product.game];
    const gallery = galleryFor(db, product);
    res.render('product', {
      title: `${product.name}${product.set_name ? ` — ${product.set_name}` : ''}`,
      description: productDescription(product),
      ogType: 'product',
      ogImage: gallery[0]?.lg.url ?? null,
      structuredData: [
        productJsonLd(product, { baseUrl: config.baseUrl, shopName: config.shopName, images: gallery.map((img) => img.lg.url) }),
        breadcrumbJsonLd(config.baseUrl, [['Accueil', '/'], [game.label, gamePath(product.game)], [product.name]]),
      ],
      product, gallery, related, inWishlist,
    });
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

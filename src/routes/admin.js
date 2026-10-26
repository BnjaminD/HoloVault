import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ORDER_STATUSES, slugify } from '../lib/catalog.js';
import { addOrderEvent, getOrderWithItems, releaseOrder } from '../lib/orders.js';
import { formatIssues, orderStatusSchema, productSchema, promoSchema } from '../lib/validation.js';
import { flash, requireAdmin, requireCsrf } from '../middleware.js';

const IMAGE_SIGNATURES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

// Trust the file's bytes, never its name or declared MIME type.
export function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return IMAGE_SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;
}

const PAGE_SIZE = 25;
const FINAL_STATUSES = ['cancelled', 'refunded'];

export function adminRoutes({ db, config, mailer }) {
  const router = Router();
  mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 40, fieldSize: 10_000 },
  }).single('image');

  const parseMultipart = (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        err.status = 400;
        flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Image trop lourde (5 Mo maximum).' : 'Envoi de fichier invalide.');
        return res.redirect(req.originalUrl);
      }
      next(err);
    });

  router.use(requireAdmin);

  router.get('/', (req, res) => {
    const stats = db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE status IN ('paid','preparing','shipped','delivered')) AS revenue,
           (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE status IN ('paid','preparing','shipped','delivered') AND paid_at > ?) AS revenue30,
           (SELECT COUNT(*) FROM orders WHERE status IN ('paid','preparing')) AS toShip,
           (SELECT COUNT(*) FROM orders WHERE status != 'pending_payment' AND status != 'cancelled') AS orders,
           (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
           (SELECT COUNT(*) FROM products WHERE active = 1) AS products`,
      )
      .get(Date.now() - 30 * 86_400_000);
    const lowStock = db.prepare('SELECT * FROM products WHERE active = 1 AND stock <= 1 ORDER BY stock, name LIMIT 10').all();
    const recent = db.prepare("SELECT * FROM orders WHERE status != 'pending_payment' ORDER BY created_at DESC LIMIT 8").all();
    res.render('admin/dashboard', { title: 'Tableau de bord', stats, lowStock, recent });
  });

  // ---- Produits ----
  router.get('/produits', (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 80);
    const products = q
      ? db.prepare("SELECT * FROM products WHERE name LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 200").all(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      : db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 200').all();
    res.render('admin/products', { title: 'Produits', products, q });
  });

  const renderForm = (res, product, errors = [], status = 200) =>
    res.status(status).render('admin/product-form', { title: product.id ? 'Modifier le produit' : 'Nouveau produit', product, errors });

  router.get('/produits/nouveau', (req, res) =>
    renderForm(res, { game: 'pokemon', category: 'single', condition: 'near_mint', language: 'FR', active: 1, stock: 1 }),
  );

  function saveImage(file) {
    if (!file) return null;
    const ext = detectImageType(file.buffer);
    if (!ext) throw Object.assign(new Error('Format d’image non supporté (JPG, PNG ou WebP uniquement).'), { userFacing: true });
    const name = `${randomUUID()}.${ext}`;
    writeFileSync(join(config.uploadDir, name), file.buffer, { mode: 0o644 });
    return `/uploads/${name}`;
  }

  function removeImage(path) {
    if (!path?.startsWith('/uploads/')) return;
    try {
      unlinkSync(join(config.uploadDir, basename(path)));
    } catch {
      /* already gone */
    }
  }

  function uniqueSlug(name, ignoreId = 0) {
    const base = slugify(name) || 'produit';
    let slug = base;
    // Former slugs of other products stay reserved: their old links must keep redirecting to them.
    const taken = db.prepare(
      'SELECT 1 FROM products WHERE slug = ? AND id != ? UNION ALL SELECT 1 FROM product_slug_history WHERE slug = ? AND product_id != ?',
    );
    for (let i = 2; taken.get(slug, ignoreId, slug, ignoreId); i++) slug = `${base}-${i}`;
    return slug;
  }

  function productValues(body) {
    return {
      ...body,
      set_name: body.setName, card_number: body.cardNumber, is_featured: body.isFeatured === 'on', active: body.active === 'on',
    };
  }

  router.post('/produits', parseMultipart, requireCsrf, (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return renderForm(res, productValues(req.body), formatIssues(parsed.error), 400);
    let image;
    try {
      image = saveImage(req.file);
    } catch (err) {
      if (err.userFacing) return renderForm(res, productValues(req.body), [err.message], 400);
      throw err;
    }
    const d = parsed.data;
    db.prepare(
      `INSERT INTO products (slug, name, game, category, set_name, card_number, rarity, condition, language, grading, description,
         price_cents, stock, is_featured, image_path, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uniqueSlug(d.name), d.name, d.game, d.category, d.setName, d.cardNumber, d.rarity, d.condition, d.language, d.grading,
      d.description, Math.round(d.price * 100), d.stock, d.isFeatured ? 1 : 0, image ?? '', d.active ? 1 : 0, Date.now(),
    );
    flash(req, 'success', 'Produit créé.');
    res.redirect('/admin/produits');
  });

  router.get('/produits/:id', (req, res, next) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return next();
    renderForm(res, product);
  });

  router.post('/produits/:id', parseMultipart, requireCsrf, (req, res, next) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!existing) return next();
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return renderForm(res, { ...productValues(req.body), id: existing.id, image_path: existing.image_path }, formatIssues(parsed.error), 400);
    let image;
    try {
      image = saveImage(req.file);
    } catch (err) {
      if (err.userFacing) return renderForm(res, { ...productValues(req.body), id: existing.id, image_path: existing.image_path }, [err.message], 400);
      throw err;
    }
    const d = parsed.data;
    const removeCurrent = req.body.removeImage === 'on';
    const imagePath = image ?? (removeCurrent ? '' : existing.image_path);
    if (image || removeCurrent) removeImage(existing.image_path);
    const slug = d.name === existing.name ? existing.slug : uniqueSlug(d.name, existing.id);
    db.transaction(() => {
      if (slug !== existing.slug) {
        db.prepare('INSERT OR REPLACE INTO product_slug_history (slug, product_id, created_at) VALUES (?, ?, ?)').run(existing.slug, existing.id, Date.now());
        db.prepare('DELETE FROM product_slug_history WHERE slug = ?').run(slug);
      }
      db.prepare(
        `UPDATE products SET slug = ?, name = ?, game = ?, category = ?, set_name = ?, card_number = ?, rarity = ?, condition = ?, language = ?,
           grading = ?, description = ?, price_cents = ?, stock = ?, is_featured = ?, image_path = ?, active = ?, updated_at = ? WHERE id = ?`,
      ).run(
        slug, d.name, d.game, d.category, d.setName, d.cardNumber,
        d.rarity, d.condition, d.language, d.grading, d.description, Math.round(d.price * 100), d.stock, d.isFeatured ? 1 : 0,
        imagePath, d.active ? 1 : 0, Date.now(), existing.id,
      );
    })();

    if (existing.stock === 0 && d.stock > 0 && d.active) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
      const alerts = db.prepare('SELECT email FROM stock_alerts WHERE product_id = ?').all(existing.id);
      // Queued in the outbox first, so a subscriber is only dropped once their e-mail is safely stored.
      for (const { email } of alerts) {
        if (mailer.stockAlert(email, product)) db.prepare('DELETE FROM stock_alerts WHERE product_id = ? AND email = ?').run(existing.id, email);
      }
      if (alerts.length) flash(req, 'info', `${alerts.length} client(s) prévenu(s) du retour en stock.`);
    }
    flash(req, 'success', 'Produit mis à jour.');
    res.redirect('/admin/produits');
  });

  router.post('/produits/:id/archiver', (req, res) => {
    db.prepare('UPDATE products SET active = 0, is_featured = 0, updated_at = ? WHERE id = ?').run(Date.now(), Number(req.params.id));
    flash(req, 'success', 'Produit archivé (retiré de la boutique).');
    res.redirect('/admin/produits');
  });

  // ---- Commandes ----
  router.get('/commandes', (req, res) => {
    // Defensive: only a plain string may reach the SQL parameter.
    const status = typeof req.query.status === 'string' && Object.hasOwn(ORDER_STATUSES, req.query.status) ? req.query.status : '';
    const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
    const where = status ? 'WHERE status = ?' : "WHERE status != 'pending_payment'";
    const params = status ? [status] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...params).n;
    const orders = db
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/orders', { title: 'Commandes', orders, status, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
  });

  router.get('/commandes/:id', (req, res, next) => {
    const order = getOrderWithItems(db, Number(req.params.id));
    if (!order) return next();
    res.render('admin/order', { title: `Commande ${order.reference}`, order });
  });

  router.post('/commandes/:id/statut', (req, res, next) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return next();
    const parsed = orderStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      flash(req, 'error', formatIssues(parsed.error).join(' · '));
      return res.redirect(`/admin/commandes/${order.id}`);
    }
    const { status, trackingNumber, note } = parsed.data;

    if (order.status === 'pending_payment') {
      if (status === 'cancelled') releaseOrder(db, order.id, note || 'Annulée par la boutique');
      else flash(req, 'error', 'Une commande non payée ne peut être qu’annulée.');
      return res.redirect(`/admin/commandes/${order.id}`);
    }

    // Cancelled/refunded orders are final: reopening one would sell stock that was already put back.
    if (FINAL_STATUSES.includes(order.status) && status !== order.status) {
      flash(req, 'error', 'Une commande annulée ou remboursée ne peut plus changer de statut.');
      return res.redirect(`/admin/commandes/${order.id}`);
    }

    db.transaction(() => {
      if (status === 'cancelled' && ['paid', 'preparing'].includes(order.status)) {
        for (const item of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)) {
          if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
        }
      }
      db.prepare('UPDATE orders SET status = ?, tracking_number = ?, updated_at = ? WHERE id = ?').run(status, trackingNumber, Date.now(), order.id);
      if (status !== order.status || note) addOrderEvent(db, order.id, status, note);
    })();

    if (status !== order.status) {
      mailer.orderStatus({ ...order, tracking_number: trackingNumber }, ORDER_STATUSES[status]);
    }
    flash(req, 'success', 'Commande mise à jour.');
    res.redirect(`/admin/commandes/${order.id}`);
  });

  // ---- Codes promo ----
  router.get('/promos', (req, res) => {
    res.render('admin/promos', { title: 'Codes promo', promos: db.prepare('SELECT * FROM promo_codes ORDER BY code').all(), errors: [] });
  });

  router.post('/promos', (req, res) => {
    const parsed = promoSchema.safeParse(req.body);
    const promos = () => db.prepare('SELECT * FROM promo_codes ORDER BY code').all();
    if (!parsed.success) return res.status(400).render('admin/promos', { title: 'Codes promo', promos: promos(), errors: formatIssues(parsed.error) });
    const d = parsed.data;
    try {
      db.prepare('INSERT INTO promo_codes (code, percent_off, max_uses, expires_at) VALUES (?, ?, ?, ?)').run(
        d.code, d.percentOff, d.maxUses || null, d.expiresAt ? new Date(`${d.expiresAt}T23:59:59`).getTime() : null,
      );
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw err;
      return res.status(400).render('admin/promos', { title: 'Codes promo', promos: promos(), errors: ['Ce code existe déjà.'] });
    }
    flash(req, 'success', `Code ${d.code} créé.`);
    res.redirect('/admin/promos');
  });

  router.post('/promos/:code/basculer', (req, res) => {
    db.prepare('UPDATE promo_codes SET active = 1 - active WHERE code = ?').run(String(req.params.code));
    res.redirect('/admin/promos');
  });

  return router;
}

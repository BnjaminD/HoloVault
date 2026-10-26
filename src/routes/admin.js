import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ORDER_STATUSES, slugify } from '../lib/catalog.js';
import {
  ImageError, MAX_IMAGES_PER_PRODUCT, galleryFor, importLegacyImage, listProductImages, processImage, removeImageFiles, syncCover,
} from '../lib/images.js';
import { addOrderEvent, getOrderWithItems, releaseOrder } from '../lib/orders.js';
import { formatIssues, orderStatusSchema, productSchema, promoSchema } from '../lib/validation.js';
import { flash, requireAdmin, requireCsrf } from '../middleware.js';

// Kept for the security tests that exercise upload sniffing.
export { detectImageType } from '../lib/images.js';

const PAGE_SIZE = 25;
const FINAL_STATUSES = ['cancelled', 'refunded'];

export function adminRoutes({ db, config, mailer }) {
  const router = Router();
  mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: MAX_IMAGES_PER_PRODUCT, fields: 40 + 3 * MAX_IMAGES_PER_PRODUCT, fieldSize: 10_000 },
  }).array('images', MAX_IMAGES_PER_PRODUCT);

  const parseMultipart = (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        err.status = 400;
        flash(req, 'error', { LIMIT_FILE_SIZE: 'Image trop lourde (10 Mo maximum).', LIMIT_FILE_COUNT: `${MAX_IMAGES_PER_PRODUCT} photos maximum.`, LIMIT_UNEXPECTED_FILE: `${MAX_IMAGES_PER_PRODUCT} photos maximum.` }[err.code] ?? 'Envoi de fichier invalide.');
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
    res.status(status).render('admin/product-form', {
      title: product.id ? 'Modifier le produit' : 'Nouveau produit',
      product,
      gallery: product.id ? galleryFor(db, product) : [],
      maxImages: MAX_IMAGES_PER_PRODUCT,
      errors,
    });

  router.get('/produits/nouveau', (req, res) =>
    renderForm(res, { game: 'pokemon', category: 'single', condition: 'near_mint', language: 'FR', active: 1, stock: 1 }),
  );

  function removeLegacyFile(path) {
    if (!/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(path ?? '')) return;
    rmSync(join(config.uploadDir, basename(path)), { force: true });
  }

  // Re-encodes the uploaded files; on any failure, already written variants are removed.
  async function processUploads(files = []) {
    const done = [];
    try {
      for (const file of files) done.push(await processImage(file.buffer, config.uploadDir));
    } catch (err) {
      for (const img of done) removeImageFiles(config.uploadDir, img.key);
      throw err;
    }
    return done;
  }

  // Applies the gallery part of the form: removals, captions, cover choice, then new photos appended.
  // Must run inside the product transaction; returns the file keys to delete once it has committed.
  function saveGallery(productId, body, uploaded) {
    const current = listProductImages(db, productId);
    const removed = current.filter((img) => body[`remove_${img.id}`] === 'on');
    const kept = current.filter((img) => !removed.includes(img));
    const coverId = Number(body.cover);
    kept.sort((a, b) => (b.id === coverId) - (a.id === coverId));
    const del = db.prepare('DELETE FROM product_images WHERE id = ?');
    for (const img of removed) del.run(img.id);
    const update = db.prepare('UPDATE product_images SET position = ?, alt = ? WHERE id = ?');
    kept.forEach((img, i) => update.run(i, String(body[`alt_${img.id}`] ?? img.alt).trim().slice(0, 120), img.id));
    const insert = db.prepare('INSERT INTO product_images (product_id, file_key, position, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    uploaded.forEach((img, i) => insert.run(productId, img.key, kept.length + i, img.width, img.height, Date.now()));
    syncCover(db, productId);
    return removed.map((img) => img.file_key);
  }

  const tooManyImages = (count) => `${MAX_IMAGES_PER_PRODUCT} photos maximum par produit (${count} demandées).`;

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

  router.post('/produits', parseMultipart, requireCsrf, async (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return renderForm(res, productValues(req.body), formatIssues(parsed.error), 400);
    let uploaded;
    try {
      uploaded = await processUploads(req.files);
    } catch (err) {
      if (err instanceof ImageError) return renderForm(res, productValues(req.body), [err.message], 400);
      throw err;
    }
    const d = parsed.data;
    try {
      db.transaction(() => {
        const { lastInsertRowid } = db.prepare(
          `INSERT INTO products (slug, name, game, category, set_name, card_number, rarity, condition, language, grading, description,
             price_cents, stock, is_featured, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          uniqueSlug(d.name), d.name, d.game, d.category, d.setName, d.cardNumber, d.rarity, d.condition, d.language, d.grading,
          d.description, Math.round(d.price * 100), d.stock, d.isFeatured ? 1 : 0, d.active ? 1 : 0, Date.now(),
        );
        saveGallery(Number(lastInsertRowid), {}, uploaded);
      })();
    } catch (err) {
      for (const img of uploaded) removeImageFiles(config.uploadDir, img.key);
      throw err;
    }
    flash(req, 'success', 'Produit créé.');
    res.redirect('/admin/produits');
  });

  router.get('/produits/:id', (req, res, next) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return next();
    renderForm(res, product);
  });

  router.post('/produits/:id', parseMultipart, requireCsrf, async (req, res, next) => {
    let existing = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!existing) return next();
    const formError = (errors) => renderForm(res, { ...productValues(req.body), id: existing.id, image_path: existing.image_path }, errors, 400);
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return formError(formatIssues(parsed.error));

    // A pre-gallery photo joins the gallery first, unless the admin asked to drop it.
    if (req.body.removeLegacyImage === 'on') {
      removeLegacyFile(existing.image_path);
      db.prepare("UPDATE products SET image_path = '' WHERE id = ?").run(existing.id);
    } else if (await importLegacyImage(db, config.uploadDir, existing).catch(() => false)) {
      flash(req, 'info', 'L’ancienne photo a été convertie et ajoutée à la galerie.');
    }
    existing = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);

    const current = listProductImages(db, existing.id);
    const remaining = current.filter((img) => req.body[`remove_${img.id}`] !== 'on').length + (req.files?.length ?? 0);
    if (remaining > MAX_IMAGES_PER_PRODUCT) return formError([tooManyImages(remaining)]);
    let uploaded;
    try {
      uploaded = await processUploads(req.files);
    } catch (err) {
      if (err instanceof ImageError) return formError([err.message]);
      throw err;
    }
    const d = parsed.data;
    const slug = d.name === existing.name ? existing.slug : uniqueSlug(d.name, existing.id);
    let deletedKeys;
    try {
      deletedKeys = db.transaction(() => {
        if (slug !== existing.slug) {
          db.prepare('INSERT OR REPLACE INTO product_slug_history (slug, product_id, created_at) VALUES (?, ?, ?)').run(existing.slug, existing.id, Date.now());
          db.prepare('DELETE FROM product_slug_history WHERE slug = ?').run(slug);
        }
        db.prepare(
          `UPDATE products SET slug = ?, name = ?, game = ?, category = ?, set_name = ?, card_number = ?, rarity = ?, condition = ?, language = ?,
             grading = ?, description = ?, price_cents = ?, stock = ?, is_featured = ?, active = ?, updated_at = ? WHERE id = ?`,
        ).run(
          slug, d.name, d.game, d.category, d.setName, d.cardNumber,
          d.rarity, d.condition, d.language, d.grading, d.description, Math.round(d.price * 100), d.stock, d.isFeatured ? 1 : 0,
          d.active ? 1 : 0, Date.now(), existing.id,
        );
        return saveGallery(existing.id, req.body, uploaded);
      })();
    } catch (err) {
      for (const img of uploaded) removeImageFiles(config.uploadDir, img.key);
      throw err;
    }
    for (const key of deletedKeys) removeImageFiles(config.uploadDir, key);

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

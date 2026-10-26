import { Router } from 'express';
import { getOrderWithItems } from '../lib/orders.js';
import { hashSecret, verifySecret } from '../lib/security.js';
import { formatIssues, passwordChangeSchema, profileSchema } from '../lib/validation.js';
import { flash, requireAuth } from '../middleware.js';
import { regenerateSession } from './auth.js';

const TABS = ['commandes', 'profil', 'favoris', 'securite'];

export function accountRoutes({ db, limiters, store }) {
  const router = Router();

  function renderAccount(req, res, { tab, errors = [], status = 200 } = {}) {
    const userId = res.locals.user.id;
    const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const orders = db
      .prepare("SELECT * FROM orders WHERE user_id = ? AND status != 'pending_payment' ORDER BY created_at DESC")
      .all(userId);
    const wishlist = db
      .prepare('SELECT p.* FROM wishlist w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND p.active = 1 ORDER BY w.created_at DESC')
      .all(userId);
    const active = TABS.includes(tab) ? tab : TABS.includes(req.query.onglet) ? req.query.onglet : 'commandes';
    res.status(status).render('account', { title: 'Mon compte', profile, orders, wishlist, tab: active, errors });
  }

  router.get('/compte', requireAuth, (req, res) => renderAccount(req, res));

  router.get('/compte/commandes/:reference', requireAuth, (req, res, next) => {
    // Scoped to the logged-in user: another customer's reference returns 404 (no IDOR).
    const row = db
      .prepare('SELECT id FROM orders WHERE reference = ? AND user_id = ?')
      .get(String(req.params.reference), res.locals.user.id);
    if (!row) return next();
    res.render('order-detail', { title: `Commande ${String(req.params.reference)}`, order: getOrderWithItems(db, row.id), guest: false });
  });

  router.post('/compte/profil', requireAuth, (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return renderAccount(req, res, { tab: 'profil', errors: formatIssues(parsed.error), status: 400 });
    const d = parsed.data;
    db.prepare(
      `UPDATE users SET first_name = ?, last_name = ?, phone = ?, address_line1 = ?, address_line2 = ?, postal_code = ?, city = ?, country = ?
       WHERE id = ?`,
    ).run(d.firstName, d.lastName, d.phone, d.addressLine1, d.addressLine2, d.postalCode, d.city, d.country, res.locals.user.id);
    flash(req, 'success', 'Profil mis à jour.');
    res.redirect('/compte?onglet=profil');
  });

  router.post('/compte/mot-de-passe', requireAuth, limiters.auth, async (req, res) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) return renderAccount(req, res, { tab: 'securite', errors: formatIssues(parsed.error), status: 400 });
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(res.locals.user.id);
    if (!(await verifySecret(parsed.data.currentPassword, user.password_hash))) {
      return renderAccount(req, res, { tab: 'securite', errors: ['Mot de passe actuel incorrect.'], status: 400 });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashSecret(parsed.data.newPassword), user.id);
    // Sign out every other session of this user, then rotate the current one.
    const sessions = db.prepare('SELECT sid, sess FROM sessions').all();
    for (const s of sessions) {
      if (s.sid !== req.sessionID && JSON.parse(s.sess).userId === user.id) store.destroy(s.sid);
    }
    await regenerateSession(req, { userId: user.id, authAt: Date.now() });
    flash(req, 'success', 'Mot de passe modifié. Vos autres sessions ont été déconnectées.');
    res.redirect('/compte?onglet=securite');
  });

  router.post('/compte/supprimer', requireAuth, limiters.auth, async (req, res) => {
    const user = db.prepare('SELECT id, password_hash, role FROM users WHERE id = ?').get(res.locals.user.id);
    if (user.role === 'admin' || !(await verifySecret(String(req.body.password ?? ''), user.password_hash))) {
      return renderAccount(req, res, { tab: 'securite', errors: ['Mot de passe incorrect.'], status: 400 });
    }
    // Orders are kept for accounting (legal obligation) but detached from the account.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    req.session.destroy(() => res.redirect('/?compte=supprime'));
  });

  // Guest order access (logged in with reference + order number).
  router.get('/suivi', (req, res) => {
    const guest = req.session.guestOrder;
    if (!guest) return res.redirect('/connexion?mode=commande');
    const order = getOrderWithItems(db, guest.id);
    if (!order) {
      delete req.session.guestOrder;
      return res.redirect('/connexion?mode=commande');
    }
    res.render('order-detail', { title: `Commande ${order.reference}`, order, guest: true });
  });

  return router;
}

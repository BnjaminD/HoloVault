import { Router } from 'express';
import { burnVerifyTime, hashSecret, normalizeCode, normalizeReference, safeRedirectPath, verifySecret } from '../lib/security.js';
import { formatIssues, guestLoginSchema, loginSchema, registerSchema } from '../lib/validation.js';
import { flash } from '../middleware.js';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'E-mail ou mot de passe incorrect (ou compte temporairement verrouillé).';
const GENERIC_ORDER_ERROR = 'Référence ou numéro de commande incorrect (ou accès temporairement verrouillé).';

// New session id on every privilege change (prevents session fixation); the cart survives.
export function regenerateSession(req, data) {
  const keep = { cart: req.session.cart, shippingMethod: req.session.shippingMethod };
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, keep, data);
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

export function authRoutes({ db, limiters, config }) {
  const router = Router();

  const renderLogin = (res, extra = {}, status = 200) =>
    res.status(status).render('login', {
      title: 'Connexion',
      mode: 'account',
      next: '',
      errors: [],
      values: {},
      ...extra,
    });

  router.get('/connexion', (req, res) => {
    if (res.locals.user) return res.redirect('/compte');
    renderLogin(res, { mode: req.query.mode === 'commande' ? 'order' : 'account', next: safeRedirectPath(req.query.next, '') });
  });

  router.post('/connexion', limiters.auth, async (req, res) => {
    const next = safeRedirectPath(req.body.next, '/compte');
    const parsed = loginSchema.safeParse(req.body);
    const fail = () => renderLogin(res, { errors: [GENERIC_LOGIN_ERROR], values: { email: req.body.email }, next }, 401);
    if (!parsed.success) return fail();

    const { email, password } = parsed.data;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      await burnVerifyTime(password);
      return fail();
    }
    if (user.locked_until > Date.now()) {
      await burnVerifyTime(password);
      return fail();
    }
    if (!(await verifySecret(password, user.password_hash))) {
      const failures = user.failed_logins + 1;
      if (failures >= MAX_FAILURES) {
        db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(Date.now() + LOCK_MS, user.id);
      } else {
        db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failures, user.id);
      }
      return fail();
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
    await regenerateSession(req, { userId: user.id, authAt: Date.now() });
    flash(req, 'success', `Bon retour, ${user.first_name} !`);
    res.redirect(user.role === 'admin' && next === '/compte' ? '/admin' : next);
  });

  router.post('/connexion/commande', limiters.auth, async (req, res) => {
    const parsed = guestLoginSchema.safeParse(req.body);
    const fail = () =>
      renderLogin(res, { mode: 'order', errors: [GENERIC_ORDER_ERROR], values: { reference: req.body.reference } }, 401);
    if (!parsed.success) return fail();

    const reference = normalizeReference(parsed.data.reference);
    const code = normalizeCode(parsed.data.code);
    const order = db.prepare('SELECT id, reference, access_code_hash, failed_access, locked_until FROM orders WHERE reference = ?').get(reference);
    if (!order || order.locked_until > Date.now()) {
      await burnVerifyTime(code);
      return fail();
    }
    if (!(await verifySecret(code, order.access_code_hash))) {
      const failures = order.failed_access + 1;
      if (failures >= MAX_FAILURES) {
        db.prepare('UPDATE orders SET failed_access = 0, locked_until = ? WHERE id = ?').run(Date.now() + 2 * LOCK_MS, order.id);
      } else {
        db.prepare('UPDATE orders SET failed_access = ? WHERE id = ?').run(failures, order.id);
      }
      return fail();
    }
    db.prepare('UPDATE orders SET failed_access = 0, locked_until = 0 WHERE id = ?').run(order.id);
    await regenerateSession(req, { guestOrder: { id: order.id, reference: order.reference } });
    res.redirect('/suivi');
  });

  router.get('/inscription', (req, res) => {
    if (res.locals.user) return res.redirect('/compte');
    res.render('register', { title: 'Créer un compte', errors: [], values: { country: 'FR' } });
  });

  router.post('/inscription', limiters.register, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    const values = { ...req.body, password: '', passwordConfirm: '' };
    if (!parsed.success) {
      return res.status(400).render('register', { title: 'Créer un compte', errors: formatIssues(parsed.error), values });
    }
    const d = parsed.data;
    const passwordHash = await hashSecret(d.password);
    try {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO users (email, password_hash, first_name, last_name, phone, address_line1, address_line2, postal_code, city, country, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(d.email, passwordHash, d.firstName, d.lastName, d.phone, d.addressLine1, d.addressLine2, d.postalCode, d.city, d.country, Date.now());
      await regenerateSession(req, { userId: Number(lastInsertRowid), authAt: Date.now() });
      flash(req, 'success', 'Bienvenue ! Votre compte est créé.');
      res.redirect('/compte');
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      res.status(400).render('register', {
        title: 'Créer un compte',
        errors: ['Impossible de créer un compte avec cette adresse. Si vous avez déjà un compte, connectez-vous.'],
        values,
      });
    }
  });

  router.post('/deconnexion', (req, res) => {
    const cookieName = config.isProd ? '__Host-hv.sid' : 'hv.sid';
    req.session.destroy(() => {
      res.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd });
      res.redirect('/');
    });
  });

  return router;
}

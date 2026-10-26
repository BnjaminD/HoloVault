import { rateLimit } from 'express-rate-limit';
import { cartCount } from './lib/cart.js';
import { randomToken, safeEqual } from './lib/security.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_REAUTH_MS = 2 * 60 * 60 * 1000;

export function csrfToken(req) {
  req.session.csrf ??= randomToken();
  return req.session.csrf;
}

export function isValidCsrf(req) {
  const sent = req.get('x-csrf-token') ?? req.body?._csrf;
  return safeEqual(sent, req.session?.csrf);
}

function sameOrigin(req, baseUrl) {
  const origin = req.get('origin');
  if (!origin) {
    // Older browsers omit Origin on same-origin form posts; fall back to Referer when present.
    const referer = req.get('referer');
    if (!referer) return true;
    try {
      return new URL(referer).origin === new URL(baseUrl).origin || new URL(referer).host === req.get('host');
    } catch {
      return false;
    }
  }
  try {
    return origin === new URL(baseUrl).origin || new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

export function csrfProtection(baseUrl) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!sameOrigin(req, baseUrl)) return forbidden(req, res);
    // Multipart routes check the token themselves once the body is parsed (see requireCsrf).
    if (req.is('multipart/form-data')) return next();
    if (!isValidCsrf(req)) return forbidden(req, res);
    next();
  };
}

export function requireCsrf(req, res, next) {
  if (!isValidCsrf(req)) return forbidden(req, res);
  next();
}

// Error pages can be rendered before loadLocals ran (CSRF rejection, early crash): fill what the layout needs.
export function ensureLayoutLocals(req, res) {
  res.locals.user ??= null;
  res.locals.cartCount ??= 0;
  res.locals.flashes ??= [];
  res.locals.csrfToken ??= () => '';
  res.locals.currentPath ??= req.path;
  res.locals.guestOrderRef ??= null;
}

function forbidden(req, res) {
  if (wantsJson(req)) return res.status(403).json({ error: 'Session expirée, rechargez la page.' });
  ensureLayoutLocals(req, res);
  res.status(403).render('error', { title: 'Action refusée', status: 403, message: 'Votre session a expiré ou la requête est invalide. Rechargez la page et réessayez.' });
}

export function wantsJson(req) {
  return req.path.startsWith('/api/') || req.get('accept')?.includes('application/json');
}

export function flash(req, type, message) {
  req.session.flash ??= [];
  req.session.flash.push({ type, message });
}

export function loadLocals(db) {
  const getUser = db.prepare('SELECT id, email, first_name, last_name, role FROM users WHERE id = ?');
  return (req, res, next) => {
    if (req.session?.userId) {
      const user = getUser.get(req.session.userId);
      if (user) res.locals.user = user;
      else delete req.session.userId;
    }
    res.locals.user ??= null;
    res.locals.cartCount = cartCount(req);
    res.locals.currentPath = req.path;
    res.locals.flashes = req.session?.flash ?? [];
    if (req.session?.flash) delete req.session.flash;
    res.locals.csrfToken = () => csrfToken(req);
    res.locals.guestOrderRef = req.session?.guestOrder?.reference ?? null;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (res.locals.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Connexion requise' });
  res.redirect(`/connexion?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireAdmin(req, res, next) {
  const user = res.locals.user;
  if (!user || user.role !== 'admin') {
    // 404 rather than 403: the back-office should not advertise itself.
    return res.status(404).render('error', { title: 'Page introuvable', status: 404, message: 'Cette page n’existe pas.' });
  }
  if (!req.session.authAt || Date.now() - req.session.authAt > ADMIN_REAUTH_MS) {
    flash(req, 'info', 'Par sécurité, reconnectez-vous pour accéder à l’administration.');
    delete req.session.userId;
    return res.redirect(`/connexion?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

const limiterMessage = (req, res) => {
  const message = 'Trop de tentatives. Patientez quelques minutes avant de réessayer.';
  if (wantsJson(req)) return res.status(429).json({ error: message });
  res.status(429).render('error', { title: 'Trop de requêtes', status: 429, message });
};

export function createLimiters({ disabled = false } = {}) {
  const make = (windowMs, limit) =>
    disabled
      ? (req, res, next) => next()
      : rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: limiterMessage });
  return {
    global: make(60_000, 300),
    auth: make(15 * 60_000, 10),
    register: make(60 * 60_000, 5),
    checkout: make(10 * 60_000, 30),
    form: make(10 * 60_000, 20),
  };
}

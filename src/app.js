import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { ROOT } from './config.js';
import * as catalog from './lib/catalog.js';
import { setScryptCost } from './lib/security.js';
import { SqliteSessionStore } from './lib/session-store.js';
import { createLimiters, csrfProtection, ensureLayoutLocals, loadLocals, wantsJson } from './middleware.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { cartRoutes } from './routes/cart.js';
import { checkoutRoutes, paypalWebhookRoute } from './routes/checkout.js';
import { pageRoutes } from './routes/pages.js';
import { shopRoutes } from './routes/shop.js';

const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function createApp({ db, config, paypal, mailer, disableRateLimit = false }) {
  setScryptCost(config.scryptCost);
  const app = express();
  const store = new SqliteSessionStore(db, { defaultTtlMs: SESSION_TTL_MS });
  const limiters = createLimiters({ disabled: disableRateLimit });
  const ctx = { db, config, paypal, mailer, limiters, store };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', `${ROOT}views`);
  if (config.isProd) app.set('view cache', true);

  Object.assign(app.locals, {
    shopName: config.shopName,
    paypalMode: paypal.mode,
    ...catalog,
  });

  app.use((req, res, next) => {
    res.locals.nonce = randomBytes(16).toString('base64');
    next();
  });

  const nonce = (req, res) => `'nonce-${res.locals.nonce}'`;
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", nonce, 'https://www.paypal.com', 'https://*.paypal.com', 'https://*.paypalobjects.com'],
          styleSrc: ["'self'", nonce],
          imgSrc: ["'self'", 'data:', 'https://*.paypal.com', 'https://*.paypalobjects.com'],
          connectSrc: ["'self'", 'https://*.paypal.com'],
          frameSrc: ['https://*.paypal.com'],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // PayPal opens a popup that must be able to talk back to this window.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://www.paypal.com")');
    next();
  });

  app.use('/static', express.static(`${ROOT}public`, { maxAge: config.isProd ? '7d' : 0, index: false }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', index: false, dotfiles: 'deny' }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /compte\nDisallow: /api\n'));

  app.use(limiters.global);

  // Webhook first: it is authenticated by PayPal's signature, not by session/CSRF.
  app.use('/api/paypal/webhook', express.json({ limit: '200kb' }), paypalWebhookRoute(ctx));

  app.use(express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 100 }));
  app.use(express.json({ limit: '20kb' }));

  app.use(
    session({
      name: config.isProd ? '__Host-hv.sid' : 'hv.sid',
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: SESSION_TTL_MS, path: '/' },
    }),
  );

  app.use(csrfProtection(config.baseUrl));
  app.use(loadLocals(db));

  app.use(shopRoutes(ctx));
  app.use(cartRoutes(ctx));
  app.use(authRoutes(ctx));
  app.use(accountRoutes(ctx));
  app.use(checkoutRoutes(ctx));
  app.use('/admin', adminRoutes(ctx));
  app.use(pageRoutes(ctx));

  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ error: 'Introuvable' });
    res.status(404).render('error', { title: 'Page introuvable', status: 404, message: 'Cette page n’existe pas ou plus.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[erreur]', req.method, req.originalUrl, err);
    const message = status === 500 ? 'Une erreur inattendue est survenue.' : 'Requête invalide.';
    if (res.headersSent) return;
    if (wantsJson(req)) return res.status(status).json({ error: message });
    ensureLayoutLocals(req, res);
    res.status(status).render('error', { title: 'Erreur', status, message });
  });

  return app;
}

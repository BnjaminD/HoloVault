import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const envFile = `${ROOT}.env`;
if (existsSync(envFile) && !process.env.SKIP_DOTENV) process.loadEnvFile(envFile);

function parseTrustProxy(value) {
  if (!value) return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const port = Number(env.PORT || 3000);
  const cfg = {
    env: env.NODE_ENV || 'development',
    port,
    host: env.HOST || '127.0.0.1',
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    shopName: env.SHOP_NAME || 'HoloVault',
    sessionSecret: env.SESSION_SECRET || '',
    databasePath: env.DATABASE_PATH || `${ROOT}data/shop.db`,
    uploadDir: env.UPLOAD_DIR || `${ROOT}data/uploads`,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    scryptCost: Number(env.SCRYPT_COST || 2 ** 15),
    paypal: {
      mode: env.PAYPAL_MODE || 'mock',
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      webhookId: env.PAYPAL_WEBHOOK_ID || '',
    },
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || '',
    ...overrides,
  };
  cfg.isProd = cfg.env === 'production';

  if (!cfg.sessionSecret) {
    if (cfg.isProd) throw new Error('SESSION_SECRET est obligatoire en production');
    cfg.sessionSecret = 'dev-only-insecure-secret-do-not-use-in-production';
  }
  if (cfg.isProd) {
    if (cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET doit faire au moins 32 caractères');
    if (!['sandbox', 'live'].includes(cfg.paypal.mode)) throw new Error('PAYPAL_MODE doit être sandbox ou live en production');
    if (!cfg.paypal.clientId || !cfg.paypal.clientSecret) throw new Error('Identifiants PayPal manquants');
    if (!cfg.baseUrl.startsWith('https://')) throw new Error('BASE_URL doit être en https en production');
  }
  if (!['mock', 'sandbox', 'live'].includes(cfg.paypal.mode)) throw new Error('PAYPAL_MODE invalide');
  return cfg;
}

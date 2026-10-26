import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createMailer } from './lib/mailer.js';
import { releaseExpiredOrders } from './lib/orders.js';
import { createPayPalClient } from './lib/paypal.js';
import { SqliteSessionStore } from './lib/session-store.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const paypal = createPayPalClient(config.paypal, { shopName: config.shopName });
const mailer = createMailer(config, db);
const app = createApp({ db, config, paypal, mailer });

// Housekeeping: free stock held by abandoned checkouts and drop expired sessions.
const sessions = new SqliteSessionStore(db);
const housekeeping = setInterval(() => {
  try {
    const released = releaseExpiredOrders(db);
    if (released) console.info(`[maintenance] ${released} commande(s) non payée(s) annulée(s)`);
    sessions.prune();
    mailer.purgeOld();
  } catch (err) {
    console.error('[maintenance]', err);
  }
}, 5 * 60 * 1000);
housekeeping.unref();

// Retries queued e-mails (SMTP outage, rate limit…); new messages are also sent right after being queued.
const mailRetry = setInterval(() => mailer.flush().catch((err) => console.error('[mail]', err)), 60 * 1000);
mailRetry.unref();
mailer.flush().catch((err) => console.error('[mail]', err));

const server = app.listen(config.port, config.host, () => {
  console.info(`${config.shopName} démarré sur ${config.baseUrl} (env=${config.env}, paypal=${paypal.mode})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

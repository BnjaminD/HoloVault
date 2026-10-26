import nodemailer from 'nodemailer';
import { formatPrice } from './catalog.js';

export const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// 1 min, 2 min, 4 min… capped at 6 h: about 10 h of retries before giving up.
const backoffMs = (attempts) => Math.min(60_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);

// Messages are written to email_outbox (same transaction-safe SQLite as the orders) and sent by flush(),
// so a failing SMTP server delays e-mails instead of losing them.
export function createMailer({ smtpUrl, mailFrom, shopName, baseUrl }, db, { transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null } = {}) {
  const from = mailFrom || `${shopName} <no-reply@localhost>`;
  const insert = db.prepare('INSERT INTO email_outbox (recipient, subject, body, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)');
  const due = db.prepare(
    'SELECT * FROM email_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT ?',
  );
  const markSent = db.prepare("UPDATE email_outbox SET sent_at = ?, body = '', attempts = attempts + 1, last_error = '' WHERE id = ?");
  const markRetry = db.prepare('UPDATE email_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?');
  const markFailed = db.prepare("UPDATE email_outbox SET attempts = ?, last_error = ?, failed_at = ?, body = '' WHERE id = ?");
  const purge = db.prepare('DELETE FROM email_outbox WHERE COALESCE(sent_at, failed_at) < ?');

  let running = null;

  async function deliver() {
    const now = Date.now();
    let sent = 0;
    for (const mail of due.all(now, BATCH_SIZE)) {
      try {
        await transport.sendMail({ from, to: mail.recipient, subject: mail.subject, text: mail.body });
        markSent.run(Date.now(), mail.id);
        sent++;
      } catch (err) {
        const attempts = mail.attempts + 1;
        const reason = String(err?.message ?? err).slice(0, 500);
        if (attempts >= MAX_ATTEMPTS) {
          markFailed.run(attempts, reason, Date.now(), mail.id);
          console.error(`[mail] abandon après ${attempts} essais : « ${mail.subject} » → ${mail.recipient} (${reason})`);
        } else {
          markRetry.run(attempts, reason, Date.now() + backoffMs(attempts), mail.id);
          console.error(`[mail] échec (essai ${attempts}/${MAX_ATTEMPTS}) : ${reason}`);
        }
      }
    }
    return sent;
  }

  // Sends what is due. Concurrent calls share the run in progress.
  function flush() {
    if (!transport) return Promise.resolve(0);
    running ??= deliver().finally(() => {
      running = null;
    });
    return running;
  }

  // Never throws: a mail problem must not break the payment or admin flow that triggered it.
  function enqueue(to, subject, text) {
    try {
      insert.run(to, subject, text, Date.now(), Date.now());
    } catch (err) {
      console.error(`[mail] mise en file impossible : « ${subject} »`, err);
      return false;
    }
    if (!transport) console.info(`[mail] SMTP non configuré — « ${subject} » conservé en file d’attente`);
    else setImmediate(() => flush().catch((err) => console.error('[mail]', err)));
    return true;
  }

  return {
    flush,
    purgeOld: () => purge.run(Date.now() - RETENTION_MS).changes,
    orderConfirmation(order, accessCode) {
      const lines = order.items.map((i) => `- ${i.quantity} × ${i.name} : ${formatPrice(i.unit_price_cents * i.quantity)}`);
      return enqueue(
        order.email,
        `${shopName} — Confirmation de la commande ${order.reference}`,
        [
          `Bonjour ${order.first_name},`,
          '',
          `Merci pour votre commande ${order.reference} (${formatPrice(order.total_cents)}).`,
          '',
          ...lines,
          '',
          'Pour suivre votre commande sans compte, connectez-vous sur :',
          `${baseUrl}/connexion?mode=commande`,
          `  Référence : ${order.reference}`,
          `  Numéro de commande : ${accessCode}`,
          '',
          'Conservez ce numéro : il ne vous sera pas redemandé et ne peut pas être récupéré.',
        ].join('\n'),
      );
    },
    orderStatus(order, statusLabel) {
      const tracking = order.tracking_number ? `\nNuméro de suivi : ${order.tracking_number}` : '';
      return enqueue(order.email, `${shopName} — Commande ${order.reference} : ${statusLabel}`,
        `Bonjour ${order.first_name},\n\nVotre commande ${order.reference} est maintenant : ${statusLabel}.${tracking}\n\n${baseUrl}`);
    },
    stockAlert(email, product) {
      return enqueue(email, `${shopName} — « ${product.name} » est de retour !`,
        `Bonne nouvelle : « ${product.name} » est à nouveau disponible.\n${baseUrl}/produit/${product.slug}`);
    },
  };
}

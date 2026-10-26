import nodemailer from 'nodemailer';
import { formatPrice } from './catalog.js';

export function createMailer({ smtpUrl, mailFrom, shopName, baseUrl }) {
  const transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;

  async function send(to, subject, text) {
    if (!transport) {
      console.info(`[mail] SMTP non configuré — e-mail « ${subject} » non envoyé`);
      return false;
    }
    try {
      await transport.sendMail({ from: mailFrom || `${shopName} <no-reply@localhost>`, to, subject, text });
      return true;
    } catch (err) {
      console.error('[mail] échec envoi :', err.message);
      return false;
    }
  }

  return {
    orderConfirmation(order, accessCode) {
      const lines = order.items.map((i) => `- ${i.quantity} × ${i.name} : ${formatPrice(i.unit_price_cents * i.quantity)}`);
      return send(
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
      return send(order.email, `${shopName} — Commande ${order.reference} : ${statusLabel}`,
        `Bonjour ${order.first_name},\n\nVotre commande ${order.reference} est maintenant : ${statusLabel}.${tracking}\n\n${baseUrl}`);
    },
    stockAlert(email, product) {
      return send(email, `${shopName} — « ${product.name} » est de retour !`,
        `Bonne nouvelle : « ${product.name} » est à nouveau disponible.\n${baseUrl}/produit/${product.slug}`);
    },
  };
}

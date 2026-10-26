import { Router } from 'express';
import { computeQuote, loadCartLines } from '../lib/cart.js';
import { toPayPalValue } from '../lib/catalog.js';
import { CheckoutError, addOrderEvent, createPendingOrder, getOrderWithItems, markOrderPaid, releaseOrder } from '../lib/orders.js';
import { PayPalError, verifyCapture } from '../lib/paypal.js';
import { checkoutSchema, formatIssues } from '../lib/validation.js';

export function checkoutRoutes({ db, paypal, mailer, limiters }) {
  const router = Router();

  router.get('/commande', (req, res) => {
    const lines = loadCartLines(db, req);
    if (!lines.length) return res.redirect('/panier');
    const quote = computeQuote(db, lines, { shippingMethod: req.session.shippingMethod });
    const profile = res.locals.user ? db.prepare('SELECT * FROM users WHERE id = ?').get(res.locals.user.id) : null;
    res.render('checkout', { title: 'Commande', lines, quote, profile, paypalClientId: paypal.clientId });
  });

  router.post('/api/checkout/paypal/order', limiters.checkout, async (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: formatIssues(parsed.error).join(' · ') });
    const d = parsed.data;

    // A visitor can only hold one unpaid order at a time.
    if (req.session.pendingOrder) {
      releaseOrder(db, req.session.pendingOrder.id, 'Remplacée par une nouvelle tentative');
      delete req.session.pendingOrder;
    }

    const lines = loadCartLines(db, req);
    const quote = computeQuote(db, lines, { shippingMethod: d.shippingMethod, promoCode: d.promoCode });
    if (quote.promoError) return res.status(400).json({ error: quote.promoError });

    let order;
    try {
      order = await createPendingOrder(db, { lines, quote, customer: d, userId: res.locals.user?.id });
    } catch (err) {
      if (err instanceof CheckoutError) return res.status(409).json({ error: err.message });
      throw err;
    }

    const full = getOrderWithItems(db, order.id);
    try {
      const paypalOrderId = await paypal.createOrder(full, full.items);
      db.prepare('UPDATE orders SET paypal_order_id = ?, updated_at = ? WHERE id = ?').run(paypalOrderId, Date.now(), order.id);
      req.session.pendingOrder = { id: order.id, paypalOrderId, accessCode: order.accessCode };
      res.json({ id: paypalOrderId });
    } catch (err) {
      releaseOrder(db, order.id, 'Échec de création du paiement PayPal');
      if (err instanceof PayPalError) {
        console.error('[paypal] création', err.details);
        return res.status(502).json({ error: 'PayPal est momentanément indisponible. Réessayez dans un instant.' });
      }
      throw err;
    }
  });

  router.post('/api/checkout/paypal/order/:id/capture', limiters.checkout, async (req, res) => {
    const pending = req.session.pendingOrder;
    // The PayPal order must be the one created for this very session.
    if (!pending || pending.paypalOrderId !== req.params.id) return res.status(404).json({ error: 'Commande introuvable' });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(pending.id);
    if (!order || order.status !== 'pending_payment' || order.paypal_capture_id) {
      delete req.session.pendingOrder;
      return res.status(409).json({ error: 'Le délai de paiement a expiré. Votre panier est conservé, merci de recommencer.' });
    }

    let capture;
    try {
      capture = await paypal.captureOrder(pending.paypalOrderId);
    } catch (err) {
      if (err instanceof PayPalError && err.details?.name === 'UNPROCESSABLE_ENTITY') {
        // Typically INSTRUMENT_DECLINED: the buyer can pick another funding source.
        return res.status(422).json({ error: 'Paiement refusé par PayPal. Essayez un autre moyen de paiement.', restart: true });
      }
      console.error('[paypal] capture', err.details ?? err);
      return res.status(502).json({ error: 'Le paiement n’a pas pu être confirmé. Aucun montant n’a été débité.' });
    }

    const check = verifyCapture(capture, order);
    if (!check.ok) {
      console.error(`[paypal] capture incohérente pour ${order.reference} : ${check.reason}`);
      if (check.captureId) {
        db.prepare('UPDATE orders SET paypal_capture_id = ?, updated_at = ? WHERE id = ?').run(check.captureId, Date.now(), order.id);
        addOrderEvent(db, order.id, 'pending_payment', `Paiement à vérifier manuellement (${check.reason})`);
      }
      return res.status(502).json({ error: 'Le paiement doit être vérifié par notre équipe. Nous revenons vers vous rapidement.' });
    }

    if (check.pending) {
      db.prepare('UPDATE orders SET paypal_capture_id = ?, updated_at = ? WHERE id = ?').run(check.captureId, Date.now(), order.id);
      addOrderEvent(db, order.id, 'pending_payment', 'Paiement en cours de vérification par PayPal');
    } else {
      markOrderPaid(db, order.id, check.captureId);
    }

    const full = getOrderWithItems(db, order.id);
    mailer.orderConfirmation(full, pending.accessCode).catch(() => {});
    req.session.cart = {};
    delete req.session.pendingOrder;
    req.session.lastOrder = { id: order.id, reference: order.reference, accessCode: pending.accessCode };
    req.session.guestOrder = { id: order.id, reference: order.reference };
    res.json({ redirect: '/commande/confirmation' });
  });

  router.post('/api/checkout/paypal/order/:id/cancel', (req, res) => {
    const pending = req.session.pendingOrder;
    if (pending && pending.paypalOrderId === req.params.id) {
      releaseOrder(db, pending.id, 'Paiement annulé par le client');
      delete req.session.pendingOrder;
    }
    res.json({ ok: true });
  });

  router.get('/commande/confirmation', (req, res) => {
    const last = req.session.lastOrder;
    if (!last) return res.redirect('/');
    res.render('confirmation', { title: 'Merci pour votre commande', order: getOrderWithItems(db, last.id), accessCode: last.accessCode });
  });

  return router;
}

// PayPal → server notifications. Authenticated by PayPal's signature verification API.
export function paypalWebhookRoute({ db, paypal, mailer }) {
  const router = Router();
  router.post('/', async (req, res) => {
    const event = req.body;
    let verified = false;
    try {
      verified = await paypal.verifyWebhook(req.headers, event);
    } catch (err) {
      console.error('[paypal] vérification webhook', err.details ?? err.message);
    }
    if (!verified) return res.status(400).json({ error: 'Signature invalide' });

    const resource = event?.resource ?? {};
    const paypalOrderId = resource.supplementary_data?.related_ids?.order_id;
    const order = paypalOrderId && db.prepare('SELECT * FROM orders WHERE paypal_order_id = ?').get(paypalOrderId);
    if (!order) return res.json({ received: true });

    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const amountOk = resource.amount?.currency_code === order.currency && resource.amount?.value === toPayPalValue(order.total_cents);
        if (!amountOk) {
          addOrderEvent(db, order.id, order.status, 'Webhook : montant incohérent, vérification manuelle requise');
          break;
        }
        if (markOrderPaid(db, order.id, resource.id)) {
          mailer.orderStatus(order, 'Payée').catch(() => {});
        } else if (order.status === 'cancelled' && order.paypal_capture_id !== resource.id) {
          // Paid after the 30 min hold expired: the stock is back on sale, a human must refund or re-reserve.
          db.prepare('UPDATE orders SET paypal_capture_id = ?, updated_at = ? WHERE id = ?').run(resource.id, Date.now(), order.id);
          addOrderEvent(db, order.id, 'cancelled', `Paiement reçu (${resource.id}) sur une commande annulée : rembourser ou réactiver manuellement`);
          console.error(`[paypal] paiement reçu sur la commande annulée ${order.reference}`);
        }
        break;
      }
      case 'PAYMENT.CAPTURE.DENIED':
        if (order.status === 'pending_payment') releaseOrder(db, order.id, 'Paiement refusé par PayPal');
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(Date.now(), order.id);
        addOrderEvent(db, order.id, 'refunded', event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? 'Remboursement effectué' : 'Paiement contesté (litige)');
        break;
      default:
        break;
    }
    res.json({ received: true });
  });
  return router;
}

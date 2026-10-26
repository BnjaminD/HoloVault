(() => {
  'use strict';
  const form = document.getElementById('checkout-form');
  if (!form) return;
  const csrf = form.querySelector('input[name="_csrf"]').value;
  const errorBox = document.getElementById('checkout-error');
  const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

  const api = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur inattendue'), { data });
    return data;
  };

  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const formData = () => {
    const data = Object.fromEntries(new FormData(form));
    delete data._csrf;
    return data;
  };

  // Live totals: always recomputed by the server.
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  async function refreshQuote() {
    const { shippingMethod, promoCode } = formData();
    try {
      const q = await api('/api/panier/devis', { shippingMethod, promoCode });
      setText('q-subtotal', fmt.format(q.subtotal / 100));
      setText('q-shipping', q.shipping ? fmt.format(q.shipping / 100) : 'Offerte');
      setText('q-total', fmt.format(q.total / 100));
      const discountRow = document.getElementById('q-discount-row');
      discountRow.hidden = !q.discount;
      setText('q-discount', `−${fmt.format(q.discount / 100)}`);
      const promoMsg = document.getElementById('promo-msg');
      promoMsg.textContent = q.promo ? `Code ${q.promo.code} appliqué (−${q.promo.percent} %)` : q.promoError || '';
      promoMsg.className = `small ${q.promo ? 'tag-ok' : q.promoError ? 'tag-stock-out' : ''}`;
    } catch {
      /* keep previous totals */
    }
  }
  form.querySelectorAll('input[name="shippingMethod"]').forEach((r) => r.addEventListener('change', refreshQuote));
  document.getElementById('apply-promo')?.addEventListener('click', refreshQuote);

  const validate = () => {
    if (!form.reportValidity()) {
      showError('Merci de compléter les informations de livraison.');
      return false;
    }
    showError('');
    return true;
  };

  const createOrder = async () => {
    const data = formData();
    data.acceptTerms = form.acceptTerms.checked ? 'on' : '';
    return (await api('/api/checkout/paypal/order', data)).id;
  };

  const finish = async (orderId) => {
    const result = await api(`/api/checkout/paypal/order/${encodeURIComponent(orderId)}/capture`);
    window.location.assign(result.redirect);
  };

  const cancel = (orderId) => orderId && api(`/api/checkout/paypal/order/${encodeURIComponent(orderId)}/cancel`).catch(() => {});

  // Development simulator (PAYPAL_MODE=mock): same server flow without the PayPal SDK.
  const mockBtn = document.getElementById('mock-pay');
  if (mockBtn) {
    mockBtn.addEventListener('click', async () => {
      if (!validate()) return;
      mockBtn.disabled = true;
      try {
        await finish(await createOrder());
      } catch (err) {
        showError(err.message);
        mockBtn.disabled = false;
      }
    });
    return;
  }

  if (!window.paypal) {
    showError('Le module de paiement PayPal n’a pas pu être chargé. Désactivez votre bloqueur de publicité puis rechargez la page.');
    return;
  }

  window.paypal
    .Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 48 },
      onClick: (data, actions) => (validate() ? actions.resolve() : actions.reject()),
      createOrder: async () => {
        try {
          return await createOrder();
        } catch (err) {
          showError(err.message);
          throw err;
        }
      },
      onApprove: async (data, actions) => {
        try {
          await finish(data.orderID);
        } catch (err) {
          if (err.data?.restart) return actions.restart();
          showError(err.message);
        }
      },
      onCancel: (data) => {
        cancel(data.orderID);
        showError('Paiement annulé. Votre panier est conservé.');
      },
      onError: () => showError('Une erreur est survenue avec PayPal. Aucun montant n’a été débité, merci de réessayer.'),
    })
    .render('#paypal-buttons');
})();

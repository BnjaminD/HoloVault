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
      document.querySelectorAll('[data-total]').forEach((el) => (el.textContent = fmt.format(q.total / 100)));
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

  const createOrder = async (paymentMethod = 'paypal') => {
    const data = formData();
    data.acceptTerms = form.acceptTerms.checked ? 'on' : '';
    data.paymentMethod = paymentMethod;
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
    [
      [mockBtn, 'paypal'],
      [document.getElementById('mock-card-pay'), 'card'],
    ].forEach(([btn, method]) =>
      btn.addEventListener('click', async () => {
        if (!validate()) return;
        btn.disabled = true;
        try {
          await finish(await createOrder(method));
        } catch (err) {
          showError(err.message);
          btn.disabled = false;
        }
      }),
    );
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

  // Card typed directly in the page (PayPal Card Fields, hosted iframes): only if enabled on the merchant account.
  if (typeof window.paypal.CardFields !== 'function') return;
  const field = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const cardFields = window.paypal.CardFields({
    style: {
      input: { 'font-size': '16px', color: field('--text') || '#eef0fa', padding: '12px' },
      '.invalid': { color: field('--danger') || '#ff5c7a' },
    },
    createOrder: async () => {
      try {
        return await createOrder('card');
      } catch (err) {
        showError(err.message);
        throw err;
      }
    },
    // Called once the bank's 3-D Secure step is done; the server checks its result before capturing.
    onApprove: async (data) => {
      try {
        await finish(data.orderID);
      } catch (err) {
        showError(err.message);
        cardBtn.disabled = false;
      }
    },
    onError: () => {
      showError('Le paiement par carte n’a pas abouti. Aucun montant n’a été débité, merci de réessayer.');
      cardBtn.disabled = false;
    },
  });
  if (!cardFields.isEligible()) return;
  const cardBtn = document.getElementById('card-pay');
  document.getElementById('card-payment').hidden = false;
  cardFields.NameField({ placeholder: 'Nom sur la carte' }).render('#card-name');
  cardFields.NumberField({ placeholder: 'Numéro de carte' }).render('#card-number');
  cardFields.ExpiryField({ placeholder: 'MM / AA' }).render('#card-expiry');
  cardFields.CVVField({ placeholder: 'Cryptogramme' }).render('#card-cvv');
  cardBtn.addEventListener('click', async () => {
    if (!validate()) return;
    const state = await cardFields.getState().catch(() => null);
    if (state && !state.isFormValid) return showError('Vérifiez le numéro, la date d’expiration et le cryptogramme de votre carte.');
    cardBtn.disabled = true;
    const d = formData();
    cardFields
      .submit({
        billingAddress: { addressLine1: d.addressLine1, addressLine2: d.addressLine2, adminArea2: d.city, postalCode: d.postalCode, countryCode: d.country },
      })
      .catch(() => {
        showError('Le paiement par carte n’a pas abouti. Aucun montant n’a été débité, merci de réessayer.');
        cardBtn.disabled = false;
      });
  });
})();

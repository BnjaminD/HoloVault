(() => {
  'use strict';
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';

  // Theme toggle (preference stored per browser only).
  const root = document.documentElement;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try {
        localStorage.setItem('theme', next);
      } catch {
        /* storage unavailable */
      }
    });
  });

  // Holographic foil follows the pointer; the product page card also tilts in 3D.
  document.querySelectorAll('.tcg-card.is-holo, [data-tilt] .tcg-card').forEach((card) => {
    const tilt = card.closest('[data-tilt]');
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
      if (tilt) {
        card.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
        card.style.setProperty('--rx', `${(0.5 - y) * 18}deg`);
      }
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--mx', '50%');
      card.style.setProperty('--my', '50%');
    });
  });

  // Flash messages fade away on their own.
  document.querySelectorAll('.flash-stack .alert').forEach((el, i) => {
    setTimeout(() => el.remove(), 5000 + i * 800);
  });

  // Wishlist toggle without page reload (form still works without JS).
  document.querySelectorAll('form[data-wishlist]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
      });
      if (res.ok) {
        const { inWishlist } = await res.json();
        btn.textContent = inWishlist ? '♥ Dans vos favoris' : '♡ Ajouter aux favoris';
        btn.setAttribute('aria-pressed', String(inWishlist));
      }
    });
  });

  // Copy-to-clipboard buttons (order number on confirmation page).
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const label = btn.textContent;
        btn.textContent = 'Copié ✓';
        setTimeout(() => (btn.textContent = label), 1800);
      } catch {
        /* clipboard blocked */
      }
    });
  });

  document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

  // Auto-submit selects (sort order, admin filters).
  document.querySelectorAll('select[data-autosubmit]').forEach((sel) => sel.addEventListener('change', () => sel.form.submit()));

  // Confirmation prompts for destructive actions.
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!confirm(form.dataset.confirm)) e.preventDefault();
    });
  });
})();

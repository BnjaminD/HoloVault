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

  // Product gallery: thumbnails swap the main photo; the main photo opens a zoomable lightbox.
  // Without JS every thumbnail and the main photo are plain links to the large image.
  document.querySelectorAll('[data-gallery]').forEach((gallery) => {
    const main = gallery.querySelector('[data-zoom]');
    const mainImg = main.querySelector('img');
    const thumbs = [...gallery.querySelectorAll('[data-thumb]')];
    const dialog = gallery.parentElement.querySelector('[data-lightbox]');
    const bigImg = dialog?.querySelector('img');
    let current = 0;

    const show = (i) => {
      const t = thumbs[i];
      if (!t) return;
      current = i;
      mainImg.src = t.dataset.md;
      mainImg.srcset = t.dataset.srcset;
      mainImg.width = Number(t.dataset.width);
      mainImg.height = Number(t.dataset.height);
      mainImg.alt = t.dataset.alt;
      main.href = t.href;
      thumbs.forEach((el, j) => (j === i ? el.setAttribute('aria-current', 'true') : el.removeAttribute('aria-current')));
    };

    const showBig = () => {
      bigImg.classList.remove('is-zoomed');
      bigImg.src = main.href;
      bigImg.alt = mainImg.alt;
    };

    thumbs.forEach((t, i) =>
      t.addEventListener('click', (e) => {
        e.preventDefault();
        show(i);
      }),
    );

    if (!dialog || typeof dialog.showModal !== 'function') return;
    main.addEventListener('click', (e) => {
      e.preventDefault();
      showBig();
      dialog.showModal();
    });
    dialog.querySelector('[data-lightbox-close]').addEventListener('click', () => dialog.close());
    // A click on the backdrop (outside the image and buttons) closes the lightbox.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    const step = (delta) => {
      if (thumbs.length < 2) return;
      show((current + delta + thumbs.length) % thumbs.length);
      showBig();
    };
    dialog.querySelectorAll('[data-lightbox-step]').forEach((btn) => btn.addEventListener('click', () => step(Number(btn.dataset.lightboxStep))));
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
    const follow = (e) => {
      const r = bigImg.getBoundingClientRect();
      bigImg.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
    };
    bigImg.addEventListener('click', (e) => {
      follow(e);
      bigImg.classList.toggle('is-zoomed');
    });
    bigImg.addEventListener('pointermove', (e) => {
      if (bigImg.classList.contains('is-zoomed')) follow(e);
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

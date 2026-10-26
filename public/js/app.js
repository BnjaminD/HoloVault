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

  // Search suggestions under the header search box (ARIA combobox). Submitting still runs a full search.
  const searchInput = document.getElementById('q-header');
  if (searchInput) {
    const list = document.createElement('ul');
    list.id = 'search-suggest';
    list.className = 'search-suggest';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Suggestions');
    list.hidden = true;
    searchInput.after(list);
    searchInput.setAttribute('role', 'combobox');
    searchInput.setAttribute('aria-autocomplete', 'list');
    searchInput.setAttribute('aria-controls', list.id);
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.autocomplete = 'off';

    let items = [];
    let active = -1;
    let timer;
    let controller;

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const close = () => {
      list.hidden = true;
      searchInput.setAttribute('aria-expanded', 'false');
      searchInput.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const highlight = (i) => {
      active = i;
      [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
      if (i >= 0) searchInput.setAttribute('aria-activedescendant', list.children[i].id);
      else searchInput.removeAttribute('aria-activedescendant');
    };
    const render = (query) => {
      list.replaceChildren();
      items.forEach((item, i) => {
        const li = el('li');
        li.id = `suggest-${i}`;
        li.setAttribute('role', 'option');
        const thumb = el('span', `thumb game-${item.game}`); // game colours when there is no photo
        if (item.image) {
          const img = el('img');
          img.src = item.image;
          img.alt = '';
          thumb.append(img);
        }
        const text = el('span', 's-text');
        text.append(el('span', 's-name', item.name), el('span', 's-detail', item.inStock ? item.detail : `${item.detail} · épuisé`));
        li.append(thumb, text, el('span', 's-price', item.price));
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
        li.addEventListener('click', () => (location.href = item.url));
        list.append(li);
      });
      const all = el('li', 's-all', `Voir tous les résultats pour « ${query} »`);
      all.id = `suggest-${items.length}`;
      all.setAttribute('role', 'option');
      all.addEventListener('mousedown', (e) => e.preventDefault());
      all.addEventListener('click', () => searchInput.form.submit());
      list.append(all);
      list.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
      highlight(-1);
    };

    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      const query = searchInput.value.trim();
      if (query.length < 2) return close();
      timer = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        try {
          const res = await fetch(`/api/recherche?q=${encodeURIComponent(query)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (!res.ok) return close();
          items = (await res.json()).items;
          if (searchInput.value.trim() === query) render(query);
        } catch {
          /* aborted by a newer keystroke, or offline */
        }
      }, 150);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      const count = list.children.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlight((active + 1) % count);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlight((active - 1 + count) % count);
      } else if (e.key === 'Escape') {
        close();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        list.children[active].click();
      }
    });
    searchInput.addEventListener('blur', () => setTimeout(close, 100));
  }

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

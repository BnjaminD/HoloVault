import { CATEGORIES, CONDITIONS, GAMES, formatPrice, toPayPalValue } from './catalog.js';

// Pages that must never show up in search results (customer data, transactional steps, back-office).
const PRIVATE_PATH = /^\/(admin|api|compte|panier|commande|connexion|inscription|suivi|deconnexion)(\/|$)/;
export const isPrivatePath = (path) => PRIVATE_PATH.test(path);

export const absoluteUrl = (baseUrl, path) => (/^https?:\/\//.test(path) ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);

export const gamePath = (game) => `/boutique/${game}`;

// JSON for a <script type="application/ld+json"> block: neutralises "</script>" and HTML-significant characters.
export function jsonLd(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

export function productDescription(p) {
  const parts = [p.name, GAMES[p.game]?.label, p.set_name, p.card_number && `n° ${p.card_number}`].filter(Boolean);
  const condition = p.category === 'single' || p.category === 'graded' ? CONDITIONS[p.condition]?.label : '';
  const detail = [p.grading, condition && `état ${condition}`, formatPrice(p.price_cents)].filter(Boolean).join(', ');
  const tail = p.stock > 0 ? 'En stock, expédition protégée sous 24 h.' : 'Épuisé : alerte de retour en stock disponible.';
  return truncate(`${parts.join(' — ')} (${detail}). ${p.description ? `${p.description} ` : ''}${tail}`, 160);
}

export function breadcrumbJsonLd(baseUrl, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      ...(path ? { item: absoluteUrl(baseUrl, path) } : {}),
    })),
  };
}

export function productJsonLd(p, { baseUrl, shopName }) {
  const url = absoluteUrl(baseUrl, `/produit/${p.slug}`);
  // Sealed products and mint singles are sold as new; anything that has been handled is "used" for Google.
  const isNew = p.category === 'sealed' || p.category === 'accessory' || p.condition === 'mint';
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.description || productDescription(p),
    sku: `HV-${p.id}`,
    ...(p.card_number && p.card_number !== '—' ? { mpn: p.card_number } : {}),
    category: [GAMES[p.game]?.label, CATEGORIES[p.category]].filter(Boolean).join(' > '),
    brand: { '@type': 'Brand', name: GAMES[p.game]?.label },
    ...(p.image_path ? { image: [absoluteUrl(baseUrl, p.image_path)] } : {}),
    url,
    offers: {
      '@type': 'Offer',
      url,
      price: toPayPalValue(p.price_cents),
      priceCurrency: 'EUR',
      availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: isNew ? 'https://schema.org/NewCondition' : 'https://schema.org/UsedCondition',
      seller: { '@type': 'Organization', name: shopName },
    },
  };
}

export function organizationJsonLd({ baseUrl, shopName }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'OnlineStore',
    name: shopName,
    url: `${baseUrl}/`,
    logo: absoluteUrl(baseUrl, '/static/img/favicon.svg'),
  };
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function sitemapXml(entries) {
  const urls = entries.map(({ loc, lastmod }) =>
    `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

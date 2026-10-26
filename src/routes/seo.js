import { Router } from 'express';
import { GAMES } from '../lib/catalog.js';
import { gamePath, sitemapXml } from '../lib/seo.js';
import { PAGES } from './pages.js';

export function seoRoutes({ db, config }) {
  const router = Router();
  const products = db.prepare('SELECT slug, created_at FROM products WHERE active = 1 ORDER BY id');

  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      ['User-agent: *', 'Disallow: /admin', 'Disallow: /compte', 'Disallow: /api', 'Disallow: /panier', 'Disallow: /commande', '',
        `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n'),
    );
  });

  router.get('/sitemap.xml', (req, res) => {
    const url = (path) => `${config.baseUrl}${path}`;
    const entries = [
      { loc: url('/') },
      { loc: url('/boutique') },
      ...Object.keys(GAMES).map((game) => ({ loc: url(gamePath(game)) })),
      ...products.all().map((p) => ({ loc: url(`/produit/${p.slug}`), lastmod: p.created_at })),
      ...Object.keys(PAGES).map((page) => ({ loc: url(`/${page}`) })),
    ];
    res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(sitemapXml(entries));
  });

  return router;
}

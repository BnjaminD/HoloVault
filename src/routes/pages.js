import { Router } from 'express';

export const PAGES = {
  'cgv': { title: 'Conditions générales de vente', view: 'legal/cgv' },
  'mentions-legales': { title: 'Mentions légales', view: 'legal/mentions' },
  'confidentialite': { title: 'Politique de confidentialité', view: 'legal/privacy' },
  'guide-etat': { title: 'Guide des états de cartes', view: 'legal/grading' },
  'livraison': { title: 'Livraison & retours', view: 'legal/shipping' },
};

export function pageRoutes() {
  const router = Router();
  router.get('/:page', (req, res, next) => {
    const page = Object.hasOwn(PAGES, req.params.page) ? PAGES[req.params.page] : null;
    if (!page) return next();
    res.render(page.view, { title: page.title });
  });
  return router;
}

export const GAMES = {
  pokemon: { label: 'Pokémon', symbol: '⚡' },
  yugioh: { label: 'Yu-Gi-Oh!', symbol: '👁' },
  magic: { label: 'Magic: The Gathering', symbol: '✦' },
  onepiece: { label: 'One Piece', symbol: '☠' },
  lorcana: { label: 'Disney Lorcana', symbol: '✧' },
};

export const CATEGORIES = {
  single: 'Carte à l’unité',
  graded: 'Carte gradée',
  sealed: 'Produit scellé',
  accessory: 'Accessoire',
};

export const CONDITIONS = {
  mint: { label: 'Mint', short: 'M', hint: 'Parfait, sortie de booster' },
  near_mint: { label: 'Near Mint', short: 'NM', hint: 'Quasi parfait, défauts invisibles' },
  excellent: { label: 'Excellent', short: 'EX', hint: 'Légère usure sur les bords' },
  good: { label: 'Good', short: 'GD', hint: 'Usure visible, aucune pliure' },
  light_played: { label: 'Light Played', short: 'LP', hint: 'Usure marquée, jouable' },
  played: { label: 'Played', short: 'PL', hint: 'Fortement jouée' },
};

export const LANGUAGES = { FR: 'Français', EN: 'Anglais', JP: 'Japonais', DE: 'Allemand', IT: 'Italien', ES: 'Espagnol' };

export const ORDER_STATUSES = {
  pending_payment: 'En attente de paiement',
  paid: 'Payée',
  preparing: 'En préparation',
  shipped: 'Expédiée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
  refunded: 'Remboursée',
};

export const COUNTRIES = {
  FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', MC: 'Monaco',
  DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal',
};

export const SHIPPING_METHODS = {
  letter: { label: 'Lettre suivie', detail: 'Cartes à l’unité, sous toploader — 2 à 4 jours', cents: 290 },
  colissimo: { label: 'Colissimo', detail: 'Assuré, remise contre signature — 2 à 3 jours', cents: 690 },
  express: { label: 'Chronopost Express', detail: 'Livré le lendemain avant 13 h', cents: 1290 },
};
export const FREE_SHIPPING_THRESHOLD_CENTS = 10_000;
export const MAX_QTY_PER_LINE = 10;
export const MAX_CART_LINES = 30;

const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
export const formatPrice = (cents) => eur.format(cents / 100);

export const toPayPalValue = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

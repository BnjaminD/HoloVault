// Demo catalogue. Usage: npm run seed
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { slugify } from '../src/lib/catalog.js';

const products = [
  // [name, game, category, set, number, rarity, condition, lang, grading, price €, stock, featured, description]
  ['Dracaufeu Holo 1ère Édition', 'pokemon', 'graded', 'Set de Base', '4/102', 'Holo Rare', 'mint', 'FR', 'PSA 9', 4890, 1, 1, 'Le Graal des collectionneurs français. Centrage excellent, holo sans rayure visible.'],
  ['Pikachu Illustrator (réplique officielle)', 'pokemon', 'single', 'Promo', '—', 'Promo', 'near_mint', 'JP', '', 89, 2, 0, 'Réimpression officielle japonaise.'],
  ['Mewtwo EX Full Art', 'pokemon', 'single', 'Noir & Blanc — Explorateurs Obscurs', '98/99', 'Ultra Rare', 'near_mint', 'FR', '', 64.9, 3, 0, ''],
  ['Lugia V Alternative', 'pokemon', 'single', 'Tempête Argentée', '186/195', 'Secrète Alternative', 'mint', 'FR', '', 289, 1, 1, 'L’une des alternatives les plus recherchées de l’ère Épée & Bouclier.'],
  ['Display Écarlate & Violet — 151', 'pokemon', 'sealed', 'Pokémon 151', '', '', 'mint', 'FR', '', 219, 4, 0, '36 boosters scellés, provenance distributeur officiel.'],
  ['Florizarre Holo Set de Base', 'pokemon', 'single', 'Set de Base', '15/102', 'Holo Rare', 'excellent', 'FR', '', 179, 1, 0, 'Légère usure des coins, holo brillant.'],
  ['Dracolosse Holo Wizards', 'pokemon', 'single', 'Fossile', '4/62', 'Holo Rare', 'good', 'EN', '', 39, 2, 0, ''],
  ['Magicien Sombre — LOB-005', 'yugioh', 'single', 'Legend of Blue Eyes White Dragon', 'LOB-005', 'Ultra Rare', 'near_mint', 'FR', '', 149, 1, 0, 'Première édition.'],
  ['Dragon Blanc aux Yeux Bleus — SDK-001', 'yugioh', 'graded', 'Starter Deck Kaiba', 'SDK-001', 'Ultra Rare', 'mint', 'EN', 'PSA 10', 1290, 1, 1, 'Note parfaite, l’icône absolue de Yu-Gi-Oh!.'],
  ['Exodia l’Interdit (5 pièces)', 'yugioh', 'single', 'Legend of Blue Eyes', 'LOB-124', 'Ultra Rare', 'excellent', 'FR', '', 349, 1, 1, 'Set complet des 5 pièces d’Exodia.'],
  ['Ash Blossom & Joyous Spring', 'yugioh', 'single', 'Maximum Crisis', 'MACR-036', 'Secret Rare', 'near_mint', 'FR', '', 24.9, 8, 0, ''],
  ['Booster Box — 25th Anniversary Rarity Collection', 'yugioh', 'sealed', 'Rarity Collection', '', '', 'mint', 'EN', '', 129, 3, 0, ''],
  ['Black Lotus (Unlimited)', 'magic', 'graded', 'Unlimited Edition', '—', 'Rare', 'excellent', 'EN', 'BGS 7', 18900, 1, 1, 'La carte la plus célèbre de l’histoire du jeu. Certificat BGS vérifiable.'],
  ['The One Ring — Borderless', 'magic', 'single', 'Le Seigneur des Anneaux', 'LTR-451', 'Mythique', 'near_mint', 'EN', '', 74, 2, 0, ''],
  ['Sheoldred, the Apocalypse', 'magic', 'single', 'Dominaria Uni', 'DMU-107', 'Mythique', 'near_mint', 'FR', '', 59, 4, 0, ''],
  ['Ragavan, Nimble Pilferer', 'magic', 'single', 'Modern Horizons 2', 'MH2-138', 'Mythique', 'mint', 'EN', '', 49, 2, 0, ''],
  ['Collector Booster — Modern Horizons 3', 'magic', 'sealed', 'Modern Horizons 3', '', '', 'mint', 'EN', '', 34.9, 12, 0, ''],
  ['Monkey D. Luffy — Manga Rare', 'onepiece', 'single', 'OP-05 Awakening of the New Era', 'OP05-119', 'Manga Rare', 'mint', 'JP', '', 790, 1, 1, 'Version manga ultra-rare, centrage parfait.'],
  ['Shanks — Alternate Art', 'onepiece', 'single', 'OP-01 Romance Dawn', 'OP01-120', 'Secret Rare', 'near_mint', 'EN', '', 129, 2, 0, ''],
  ['Display OP-07 500 Years in the Future', 'onepiece', 'sealed', 'OP-07', '', '', 'mint', 'FR', '', 109, 0, 0, '24 boosters scellés.'],
  ['Elsa — Enchantée', 'lorcana', 'single', 'The First Chapter', '207/204', 'Enchantée', 'mint', 'FR', '', 239, 1, 1, 'Carte enchantée du premier chapitre.'],
  ['Mickey Mouse — Brave Little Tailor', 'lorcana', 'single', 'The First Chapter', '115/204', 'Légendaire', 'near_mint', 'EN', '', 18.5, 5, 0, ''],
  ['Pochettes Dragon Shield Matte (x100)', 'pokemon', 'accessory', '', '', '', 'mint', 'FR', '', 11.9, 30, 0, 'Sleeves standard 63,5 × 88 mm, finition mate.'],
  ['Toploaders Ultra Pro 35pt (x25)', 'magic', 'accessory', '', '', '', 'mint', 'FR', '', 5.9, 40, 0, ''],
];

const config = loadConfig();
const db = openDb(config.databasePath);
const insert = db.prepare(
  `INSERT OR IGNORE INTO products (slug, name, game, category, set_name, card_number, rarity, condition, language, grading, price_cents, stock, is_featured, description, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const now = Date.now();
let added = 0;
db.transaction(() => {
  products.forEach(([name, game, category, set, number, rarity, condition, lang, grading, price, stock, featured, description], i) => {
    added += insert.run(slugify(name), name, game, category, set, number, rarity, condition, lang, grading, Math.round(price * 100), stock, featured, description, now - i * 3_600_000).changes;
  });
  db.prepare('INSERT OR IGNORE INTO promo_codes (code, percent_off) VALUES (?, ?)').run('BIENVENUE10', 10);
})();
console.info(`${added} produit(s) ajouté(s), code promo BIENVENUE10 disponible.`);
db.close();

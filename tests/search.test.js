import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAMES, formatPrice } from '../src/lib/catalog.js';
import { toFtsQuery } from '../src/lib/search.js';
import { request, setup } from './helpers.js';

function product(db, fields) {
  const p = { slug: `p-${Math.random().toString(36).slice(2, 8)}`, game: 'pokemon', category: 'single', price_cents: 1000, stock: 1, condition: 'near_mint', language: 'FR', set_name: '', card_number: '', rarity: '', grading: '', description: '', active: 1, ...fields };
  const cols = Object.keys(p);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO products (${cols.join(', ')}, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`)
    .run(...Object.values(p), Date.now());
  return { ...p, id: Number(lastInsertRowid) };
}

// Names of the products listed on a shop page, in display order.
const names = (html) => [...html.matchAll(/<h3><a href="\/produit\/[^"]+">([^<]+)<\/a><\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
const shop = async (app, query) => (await request(app).get(`/boutique?${new URLSearchParams(query)}`)).text;

describe('requête plein texte', () => {
  it('ne garde que lettres et chiffres, chaque terme entre guillemets et en préfixe', () => {
    assert.equal(toFtsQuery('Dracau 4/102'), '"dracau"* "4"* "102"*');
    assert.equal(toFtsQuery('x" OR name:* NEAR(a b) ^c -d'), '"x"* "or"* "name"* "near"* "a"* "b"* "c"* "d"*');
    assert.equal(toFtsQuery('%_--'), null);
    assert.equal(toFtsQuery(''), null);
  });
});

describe('recherche boutique', () => {
  it('insensible aux accents et à la casse, par préfixe', async () => {
    const { app, db } = setup();
    product(db, { name: 'Elsa — Enchantée', game: 'lorcana' });
    product(db, { name: 'Dracaufeu Holo' });
    assert.deepEqual(names(await shop(app, { q: 'ENCHANTEE' })), ['Elsa — Enchantée']);
    assert.deepEqual(names(await shop(app, { q: 'enchantée' })), ['Elsa — Enchantée']);
    assert.deepEqual(names(await shop(app, { q: 'dracau' })), ['Dracaufeu Holo']);
  });

  it('tous les mots doivent correspondre, sur nom, extension, numéro et gradation', async () => {
    const { app, db } = setup();
    product(db, { name: 'Dracaufeu', grading: 'PSA 9', set_name: 'Set de Base', card_number: '4/102' });
    product(db, { name: 'Dracaufeu', set_name: 'Flammes Obsidiennes', card_number: '125/197' });
    assert.equal(names(await shop(app, { q: 'dracaufeu psa' })).length, 1);
    assert.equal(names(await shop(app, { q: 'dracaufeu base' })).length, 1);
    assert.equal(names(await shop(app, { q: '4/102' })).length, 1);
    assert.equal(names(await shop(app, { q: 'dracaufeu' })).length, 2);
  });

  it('le nom du jeu est cherchable, pour chaque jeu du catalogue', async () => {
    const { app, db } = setup();
    for (const game of Object.keys(GAMES)) product(db, { name: `Produit ${game}`, game });
    for (const [game, { label }] of Object.entries(GAMES)) {
      assert.ok(names(await shop(app, { q: label })).includes(`Produit ${game}`), `recherche « ${label} »`);
    }
  });

  it('pertinence : un mot du nom passe avant un mot de la description', async () => {
    const { app, db } = setup();
    product(db, { name: 'Booster Écarlate', description: 'Contient peut-être un Mewtwo' });
    product(db, { name: 'Mewtwo EX' });
    assert.deepEqual(names(await shop(app, { q: 'mewtwo' })), ['Mewtwo EX', 'Booster Écarlate']);
  });

  it('index à jour après modification, archivage et suppression', async () => {
    const { app, db } = setup();
    const p = product(db, { name: 'Lugia' });
    db.prepare("UPDATE products SET name = 'Ho-Oh' WHERE id = ?").run(p.id);
    assert.deepEqual(names(await shop(app, { q: 'lugia' })), []);
    assert.deepEqual(names(await shop(app, { q: 'ho-oh' })), ['Ho-Oh']);
    db.prepare('UPDATE products SET stock = 0, price_cents = 5 WHERE id = ?').run(p.id);
    assert.deepEqual(names(await shop(app, { q: 'ho-oh' })), ['Ho-Oh'], 'stock/prix sans effet sur l’index');
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(p.id);
    assert.deepEqual(names(await shop(app, { q: 'ho-oh' })), []);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products_fts').get().n, 0);
  });

  it('syntaxe FTS hostile : jamais d’erreur 500', async () => {
    const { app, db } = setup();
    product(db, { name: 'Pikachu' });
    for (const q of ['"', '*', 'NEAR(a b)', 'pika OR', '-pika', '^pika', 'name:pika', '"pika', "pika'; DROP TABLE products;--", '（ｐｉｋａ）']) {
      const res = await request(app).get(`/boutique?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
    }
    assert.deepEqual(names(await shop(app, { q: '（ｐｉｋａ）' })), ['Pikachu'], 'caractères pleine chasse normalisés');
  });
});

describe('filtres', () => {
  it('état minimum : l’état choisi et les meilleurs', async () => {
    const { app, db } = setup();
    product(db, { name: 'A-mint', condition: 'mint' });
    product(db, { name: 'B-nm', condition: 'near_mint' });
    product(db, { name: 'C-ex', condition: 'excellent' });
    assert.deepEqual(names(await shop(app, { condition: 'near_mint', sort: 'name' })), ['A-mint', 'B-nm']);
  });

  it('extension, langue, société de gradation, avec compteurs', async () => {
    const { app, db } = setup();
    product(db, { name: 'Lotus', game: 'magic', set_name: 'Unlimited', language: 'EN', grading: 'BGS 7' });
    product(db, { name: 'Ring', game: 'magic', set_name: 'LTR', language: 'EN' });
    product(db, { name: 'Sheoldred', game: 'magic', set_name: 'Dominaria Uni', language: 'FR', grading: 'PSA 10' });

    let html = await shop(app, { grader: 'psa' });
    assert.deepEqual(names(html), ['Sheoldred']);
    html = await shop(app, { lang: 'EN', sort: 'name' });
    assert.deepEqual(names(html), ['Lotus', 'Ring']);
    assert.match(html, /<option value="FR" >Français \(1\)<\/option>/, 'la facette langue ignore son propre filtre');
    assert.match(html, /<option value="Unlimited" >Unlimited \(1\)<\/option>/);
    assert.doesNotMatch(html, /Dominaria Uni \(/, 'les autres facettes respectent le filtre langue');
    html = await shop(app, { set: 'unlimited' });
    assert.deepEqual(names(html), ['Lotus'], 'extension insensible à la casse');
  });

  it('filtres actifs affichés en puces retirables, page en noindex', async () => {
    const { app, db } = setup();
    product(db, { name: 'Lotus', game: 'magic', language: 'EN' });
    const html = (await request(app).get('/boutique/magic?lang=EN&inStock=1')).text;
    assert.match(html, /<a class="tag" href="\/boutique\/magic\?inStock=1" aria-label="Retirer le filtre Anglais">/);
    assert.match(html, /<a class="tag" href="\/boutique\/magic\?lang=EN" aria-label="Retirer le filtre En stock">/);
    assert.match(html, /<meta name="robots" content="noindex,follow">/);
  });
});

describe('suggestions /api/recherche', () => {
  it('meilleurs produits en vente, épuisés en dernier, inactifs exclus', async () => {
    const { app, db } = setup();
    product(db, { name: 'Pikachu Illustrator', stock: 0 });
    product(db, { name: 'Pikachu VMAX', set_name: 'Voltage Éclatant', price_cents: 2490 });
    product(db, { name: 'Pikachu archivé', active: 0 });
    const res = await request(app).get('/api/recherche?q=pika');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.name), ['Pikachu VMAX', 'Pikachu Illustrator']);
    assert.deepEqual(res.body.items[0], {
      name: 'Pikachu VMAX', url: res.body.items[0].url, game: 'pokemon', detail: 'Pokémon · Voltage Éclatant', price: formatPrice(2490), inStock: true, image: null,
    });
    assert.equal(res.body.items[1].inStock, false);
  });

  it('entrée vide, sans terme ou en tableau : liste vide, pas d’erreur', async () => {
    const { app } = setup();
    for (const qs of ['', '?q=', '?q=%25', '?q=a&q=b']) {
      const res = await request(app).get(`/api/recherche${qs}`);
      assert.equal(res.status, 200, qs);
      assert.deepEqual(res.body.items, [], qs);
    }
  });
});

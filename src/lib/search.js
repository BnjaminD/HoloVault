import { CONDITIONS } from './catalog.js';

const MAX_TERMS = 8;
// bm25 weights, in products_fts column order: name, set_name, card_number, rarity, grading, game_label, description.
const BM25 = 'bm25(products_fts, 10, 4, 6, 2, 3, 1, 1)';
const CONDITION_ORDER = Object.keys(CONDITIONS); // best first

// Turns free text into a safe FTS5 query: only letters/digits survive, each term is quoted (no operator
// injection) and prefix-matched, all terms are required. "Dracau 4/102" → "dracau"* "4"* "102"*
export function toFtsQuery(text) {
  const terms = String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms) return null;
  return [...new Set(terms)].slice(0, MAX_TERMS).map((t) => `"${t}"*`).join(' ');
}

// "Minimum condition" = that condition or any better one.
export const conditionsAtLeast = (condition) => CONDITION_ORDER.slice(0, CONDITION_ORDER.indexOf(condition) + 1);

// SQL pieces for a listing. `skip` leaves one facet's own filter out, so its options still show what
// selecting another value would give.
export function listingQuery(f, { skip } = {}) {
  const where = ['p.active = 1'];
  const params = [];
  let from = 'products p';
  const fts = f.q ? toFtsQuery(f.q) : null;
  if (fts) {
    from = `products p JOIN (SELECT rowid AS fid, ${BM25} AS rank FROM products_fts WHERE products_fts MATCH ?) m ON m.fid = p.id`;
    params.push(fts);
  } else if (f.q) {
    where.push('0'); // text with no searchable term ("%", "--"): nothing matches, rather than everything
  }
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (f.game) add('p.game = ?', f.game);
  if (f.category) add('p.category = ?', f.category);
  if (f.condition) {
    const allowed = conditionsAtLeast(f.condition);
    add(`p.condition IN (${allowed.map(() => '?').join(', ')})`, ...allowed);
  }
  if (f.set && skip !== 'set') add('p.set_name = ? COLLATE NOCASE', f.set);
  if (f.lang && skip !== 'lang') add('p.language = ?', f.lang);
  if (f.grader && skip !== 'grader') add('p.grading_company = ?', f.grader);
  if (f.minPrice != null) add('p.price_cents >= ?', Math.round(f.minPrice * 100));
  if (f.maxPrice != null) add('p.price_cents <= ?', Math.round(f.maxPrice * 100));
  if (f.inStock) where.push('p.stock > 0');
  return { from, where: where.join(' AND '), params, hasRank: !!fts };
}

export const SORTS = {
  relevance: 'm.rank, p.id DESC',
  new: 'p.created_at DESC, p.id DESC',
  price_asc: 'p.price_cents ASC, p.id',
  price_desc: 'p.price_cents DESC, p.id',
  name: 'p.name COLLATE NOCASE ASC, p.id',
};

// Relevance only makes sense with a usable text query ("%" alone has no term); it is then the default order.
export function effectiveSort(f) {
  const searchable = !!toFtsQuery(f.q);
  if (f.sort === 'relevance') return searchable ? 'relevance' : 'new';
  return f.sort ?? (searchable ? 'relevance' : 'new');
}

// Options and counts for the extension, language and grading-company filters.
export function facets(db, f) {
  const count = (skip, column, extra = '') => {
    const q = listingQuery(f, { skip });
    return db
      .prepare(`SELECT ${column} AS value, COUNT(*) AS n FROM ${q.from} WHERE ${q.where} ${extra} GROUP BY ${column} ORDER BY n DESC, value COLLATE NOCASE LIMIT 60`)
      .all(...q.params);
  };
  return {
    sets: count('set', 'p.set_name', "AND p.set_name != ''"),
    langs: count('lang', 'p.language'),
    graders: count('grader', 'p.grading_company', "AND p.grading_company != ''"),
  };
}

// Header autocomplete: best matches among products on sale.
export function suggestions(db, text, limit = 6) {
  const fts = toFtsQuery(text);
  if (!fts) return [];
  return db
    .prepare(
      `SELECT p.slug, p.name, p.game, p.set_name, p.price_cents, p.stock, p.image_path
       FROM products p JOIN (SELECT rowid AS fid, ${BM25} AS rank FROM products_fts WHERE products_fts MATCH ?) m ON m.fid = p.id
       WHERE p.active = 1 ORDER BY p.stock = 0, m.rank LIMIT ?`,
    )
    .all(fts, limit);
}

-- Full-text search: accent-insensitive (unicode61 remove_diacritics), prefix-friendly, kept in sync by triggers
-- so every write path (back-office, seed, scripts) is indexed. Searchable game labels must match GAMES in
-- src/lib/catalog.js (checked by tests/search.test.js).
CREATE VIRTUAL TABLE products_fts USING fts5(
  name, set_name, card_number, rarity, grading, game_label, description,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER products_fts_insert AFTER INSERT ON products BEGIN
  INSERT INTO products_fts (rowid, name, set_name, card_number, rarity, grading, game_label, description)
  VALUES (new.id, new.name, new.set_name, new.card_number, new.rarity, new.grading,
    CASE new.game WHEN 'pokemon' THEN 'Pokémon' WHEN 'yugioh' THEN 'Yu-Gi-Oh!' WHEN 'magic' THEN 'Magic: The Gathering'
      WHEN 'onepiece' THEN 'One Piece' WHEN 'lorcana' THEN 'Disney Lorcana' ELSE new.game END,
    new.description);
END;

CREATE TRIGGER products_fts_delete AFTER DELETE ON products BEGIN
  DELETE FROM products_fts WHERE rowid = old.id;
END;

-- Stock and price change on every order: only re-index when searchable text changes.
CREATE TRIGGER products_fts_update AFTER UPDATE OF name, set_name, card_number, rarity, grading, game, description ON products BEGIN
  DELETE FROM products_fts WHERE rowid = old.id;
  INSERT INTO products_fts (rowid, name, set_name, card_number, rarity, grading, game_label, description)
  VALUES (new.id, new.name, new.set_name, new.card_number, new.rarity, new.grading,
    CASE new.game WHEN 'pokemon' THEN 'Pokémon' WHEN 'yugioh' THEN 'Yu-Gi-Oh!' WHEN 'magic' THEN 'Magic: The Gathering'
      WHEN 'onepiece' THEN 'One Piece' WHEN 'lorcana' THEN 'Disney Lorcana' ELSE new.game END,
    new.description);
END;

INSERT INTO products_fts (rowid, name, set_name, card_number, rarity, grading, game_label, description)
SELECT id, name, set_name, card_number, rarity, grading,
  CASE game WHEN 'pokemon' THEN 'Pokémon' WHEN 'yugioh' THEN 'Yu-Gi-Oh!' WHEN 'magic' THEN 'Magic: The Gathering'
    WHEN 'onepiece' THEN 'One Piece' WHEN 'lorcana' THEN 'Disney Lorcana' ELSE game END,
  description
FROM products;

-- Grading company ("PSA 10" → "PSA") as a filterable, indexable column.
ALTER TABLE products ADD COLUMN grading_company TEXT GENERATED ALWAYS AS (
  upper(CASE WHEN instr(trim(grading), ' ') > 0 THEN substr(trim(grading), 1, instr(trim(grading), ' ') - 1) ELSE trim(grading) END)
) VIRTUAL;
CREATE INDEX idx_products_grading_company ON products (grading_company);
CREATE INDEX idx_products_set_name ON products (set_name COLLATE NOCASE);

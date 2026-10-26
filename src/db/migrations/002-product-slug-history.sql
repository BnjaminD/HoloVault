-- Former product URLs, kept so a renamed product answers its old links with a 301 instead of a 404.
CREATE TABLE product_slug_history (
  slug        TEXT PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_slug_history_product ON product_slug_history (product_id);

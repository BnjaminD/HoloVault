-- Several photos per product. Files live in UPLOAD_DIR as <file_key>-{sm,md,lg}.webp;
-- products.image_path keeps the cover's URL so listings need no join.
CREATE TABLE product_images (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  file_key    TEXT NOT NULL UNIQUE,
  position    INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  alt         TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_product_images_product ON product_images (product_id, position);

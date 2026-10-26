-- Last modification date of a product (sitemap <lastmod>, admin listing).
ALTER TABLE products ADD COLUMN updated_at INTEGER;
UPDATE products SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  address_line1   TEXT NOT NULL DEFAULT '',
  address_line2   TEXT NOT NULL DEFAULT '',
  postal_code     TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  country         TEXT NOT NULL DEFAULT 'FR',
  role            TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  game         TEXT NOT NULL CHECK (game IN ('pokemon', 'yugioh', 'magic', 'onepiece', 'lorcana')),
  category     TEXT NOT NULL DEFAULT 'single' CHECK (category IN ('single', 'graded', 'sealed', 'accessory')),
  set_name     TEXT NOT NULL DEFAULT '',
  card_number  TEXT NOT NULL DEFAULT '',
  rarity       TEXT NOT NULL DEFAULT '',
  condition    TEXT NOT NULL DEFAULT 'near_mint',
  language     TEXT NOT NULL DEFAULT 'FR',
  grading      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_featured  INTEGER NOT NULL DEFAULT 0,
  image_path   TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_game ON products (game, active);
CREATE INDEX IF NOT EXISTS idx_products_featured ON products (is_featured, active);

CREATE TABLE IF NOT EXISTS promo_codes (
  code          TEXT PRIMARY KEY COLLATE NOCASE,
  percent_off   INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  active        INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  max_uses      INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  access_code_hash  TEXT NOT NULL,
  failed_access     INTEGER NOT NULL DEFAULT 0,
  locked_until      INTEGER NOT NULL DEFAULT 0,
  user_id           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  email             TEXT NOT NULL,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  phone             TEXT NOT NULL,
  address_line1     TEXT NOT NULL,
  address_line2     TEXT NOT NULL DEFAULT '',
  postal_code       TEXT NOT NULL,
  city              TEXT NOT NULL,
  country           TEXT NOT NULL,
  shipping_method   TEXT NOT NULL,
  subtotal_cents    INTEGER NOT NULL,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  shipping_cents    INTEGER NOT NULL,
  total_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  promo_code        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  paypal_order_id   TEXT UNIQUE,
  paypal_capture_id TEXT,
  tracking_number   TEXT NOT NULL DEFAULT '',
  customer_note     TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  paid_at           INTEGER,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id        INTEGER REFERENCES products (id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  unit_price_cents  INTEGER NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wishlist (
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS stock_alerts (
  product_id  INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  email       TEXT NOT NULL COLLATE NOCASE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (product_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid      TEXT PRIMARY KEY,
  sess     TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires);

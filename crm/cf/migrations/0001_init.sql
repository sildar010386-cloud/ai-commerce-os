-- Bikas CRM, initial schema (Cloudflare D1 / SQLite).

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,   -- lower-cased, used to sign in
  name        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL CHECK (role IN ('admin', 'manager')),
  pass_hash   TEXT NOT NULL,          -- base64 PBKDF2-SHA256 output
  pass_salt   TEXT NOT NULL,          -- base64 random salt
  pass_iters  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,       -- sha-256 (hex) of the random cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Login throttling: after 10 failures an e-mail is locked for 15 minutes (also for addresses that do not exist).
CREATE TABLE login_attempts (
  email         TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_at       TEXT NOT NULL
);

CREATE TABLE products (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  price   REAL NOT NULL DEFAULT 0,
  stock   INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  num             INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  product_id      TEXT NOT NULL DEFAULT '',
  product_name    TEXT NOT NULL DEFAULT '',
  qty             INTEGER NOT NULL DEFAULT 1,
  sum             REAL NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'Другое',
  post            TEXT NOT NULL DEFAULT '',
  comment         TEXT NOT NULL DEFAULT '',
  delivery        TEXT NOT NULL DEFAULT '',
  track           TEXT NOT NULL DEFAULT '',
  remind_at       TEXT NOT NULL DEFAULT '',
  reserve_note    TEXT NOT NULL DEFAULT '',
  cancel_note     TEXT NOT NULL DEFAULT '',
  example         INTEGER NOT NULL DEFAULT 0,
  stock_deducted  INTEGER NOT NULL DEFAULT 0,
  lead_key        TEXT UNIQUE,         -- source|user|permalink for orders created by the lead hook (dedupe)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_orders_num ON orders(num);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);

-- finance: key = product id (buy, ship, pack, feePct, other) or 'general' (fixedMonth). Admin only.
CREATE TABLE finance (
  key   TEXT PRIMARY KEY,
  data  TEXT NOT NULL DEFAULT '{}'
);

-- settings: wa1, wa2, payLink, templates.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE content (
  date      TEXT NOT NULL,
  time      TEXT NOT NULL,
  code      TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL DEFAULT '',
  type      TEXT NOT NULL DEFAULT '',
  platform  TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL DEFAULT '',
  approved  INTEGER NOT NULL DEFAULT 0,
  done      TEXT NOT NULL DEFAULT '',
  url       TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT 'ждёт',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, time)
);

-- AI manager / bot statistics (one JSON document).
CREATE TABLE bot_stats (
  key   TEXT PRIMARY KEY,
  data  TEXT NOT NULL DEFAULT '{}'
);

-- Who changed what and when. Holds staff e-mails and order numbers only, never client names or phones.
CREATE TABLE audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  order_id   INTEGER,
  order_num  INTEGER,
  detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_order ON audit(order_id);

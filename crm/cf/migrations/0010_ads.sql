-- Advertising costs per product, USD -> KZT rates, link target texts to real products, repeat-customer flag on orders.
-- All dates are Almaty calendar days (YYYY-MM-DD); timestamps are ISO-8601 UTC strings like the rest of the schema.

-- One product may run several campaigns (cabinets). daily_amount is in `currency`; end_date '' = running.
CREATE TABLE ad_campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,                  -- products.id (checked by the API)
  label         TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'KZT')),
  daily_amount  REAL NOT NULL DEFAULT 0,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_ad_campaigns_product ON ad_campaigns(product_id);

-- One row per campaign per day. 'auto' rows are accrued from daily_amount, 'manual' rows are typed by the owner and never overwritten by accrual.
CREATE TABLE ad_spend (
  campaign_id  INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  amount_orig  REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  rate         REAL NOT NULL DEFAULT 1,       -- KZT per 1 unit of `currency` (1 for KZT)
  amount_kzt   REAL NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX idx_ad_spend_date ON ad_spend(date);

-- USD -> KZT per day (National Bank of Kazakhstan, fallback open.er-api.com, or typed by hand).
CREATE TABLE fx_rates (
  date        TEXT PRIMARY KEY,
  usd_kzt     REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'nbk' CHECK (source IN ('nbk', 'erapi', 'manual')),
  fetched_at  TEXT NOT NULL
);

-- A target text belongs to a real product (empty = not linked yet; product_name stays as the display name).
ALTER TABLE target_texts ADD COLUMN product_id TEXT NOT NULL DEFAULT '';

-- 1 = a customer with the same phone (last 10 digits) already had a non-cancelled order before this one.
ALTER TABLE orders ADD COLUMN is_repeat INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET is_repeat = 1 WHERE substr(replace(replace(replace(replace(replace(replace(replace(phone, ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -10) != '' AND EXISTS (SELECT 1 FROM orders o2 WHERE o2.id < orders.id AND o2.status != 'cancel' AND substr(replace(replace(replace(replace(replace(replace(replace(o2.phone, ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -10) = substr(replace(replace(replace(replace(replace(replace(replace(orders.phone, ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -10));

-- Upsell: EXTRA product lines of an order (up to 5). The main line stays in orders (product_id, qty, sum, promo).
CREATE TABLE order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL DEFAULT '',
  product_name  TEXT NOT NULL DEFAULT '',
  qty           INTEGER NOT NULL DEFAULT 1,
  sum           REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

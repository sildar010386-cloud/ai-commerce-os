-- Inbox: WhatsApp (and later Instagram Direct) chats, several business numbers, ad-text ("target") detection.
-- Times are ISO-8601 UTC strings (same as the rest of the schema), so they sort as text.

-- Business WhatsApp numbers. is_current = the number every public link (/wa, /wa/<code>) points to; at most one row.
CREATE TABLE wa_numbers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL UNIQUE,            -- digits only, international format without "+"
  label            TEXT NOT NULL DEFAULT '',
  phone_number_id  TEXT UNIQUE,                     -- WhatsApp Cloud API id, NULL until connected
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'off')),
  connection       TEXT NOT NULL DEFAULT '' CHECK (connection IN ('', 'cloud', 'qr')),  -- how messages reach the CRM
  last_seen_at     TEXT NOT NULL DEFAULT '',        -- last inbound event for this number
  is_current       INTEGER NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_wa_numbers_current ON wa_numbers(is_current) WHERE is_current = 1;

-- Pre-filled messages that ads / landing pages send. The CRM recognises a client from an ad by this text or by its code.
CREATE TABLE target_texts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name  TEXT NOT NULL DEFAULT '',
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- short, e.g. A3
  text          TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  clicks        INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE contacts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel           TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram')),
  ext_id            TEXT NOT NULL,                  -- wa_id / Instagram-scoped id
  phone             TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  traffic           TEXT NOT NULL DEFAULT 'organic' CHECK (traffic IN ('target', 'organic', 'old')),
  platform          TEXT NOT NULL DEFAULT '',       -- Instagram, Facebook, TikTok or ''
  target_code       TEXT NOT NULL DEFAULT '',
  product_name      TEXT NOT NULL DEFAULT '',
  number_id         INTEGER REFERENCES wa_numbers(id),  -- the business number the client wrote to
  first_message_at  TEXT NOT NULL DEFAULT '',
  last_inbound_at   TEXT NOT NULL DEFAULT '',
  last_message_at   TEXT NOT NULL DEFAULT '',
  last_preview      TEXT NOT NULL DEFAULT '',
  unread            INTEGER NOT NULL DEFAULT 0,
  order_id          INTEGER,
  source_manual     INTEGER NOT NULL DEFAULT 0,     -- 1 = source set by a person, never overwritten automatically
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (channel, ext_id)
);
CREATE INDEX idx_contacts_last ON contacts(last_message_at);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  number_id   INTEGER REFERENCES wa_numbers(id),
  ext_msg_id  TEXT UNIQUE,                          -- WhatsApp message id (idempotency key)
  type        TEXT NOT NULL DEFAULT 'text'
              CHECK (type IN ('text', 'voice', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'reaction', 'other')),
  body        TEXT NOT NULL DEFAULT '',
  media_id    TEXT NOT NULL DEFAULT '',
  media_url   TEXT NOT NULL DEFAULT '',          -- connector-hosted file (QR connector), alternative to media_id
  media_mime  TEXT NOT NULL DEFAULT '',
  caption     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'sent', 'delivered', 'read', 'failed')),
  from_app    INTEGER NOT NULL DEFAULT 0,           -- 1 = sent from the phone app (echo)
  ts          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_messages_contact ON messages(contact_id, ts);

-- Where an order came from: 'target' / 'organic' / '' and the ad text code.
ALTER TABLE orders ADD COLUMN traffic TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN target_code TEXT NOT NULL DEFAULT '';

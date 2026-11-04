-- WhatsApp linked-device connector (QR): single connector row, send queue (outbox), small files stored in D1.
-- The connector (connector/ in the repo) only makes outbound HTTPS calls to /api/connector/*, authenticated by a Bearer key.

CREATE TABLE connector (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash        TEXT NOT NULL DEFAULT '',     -- SHA-256 of the key; the key itself is shown once and never stored
  token_created_at  TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT '',     -- connecting | qr | open | closed | logged_out | banned | relinking
  qr_data           TEXT NOT NULL DEFAULT '',     -- PNG data URL while state = 'qr'
  qr_at             TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',     -- digits of the number the connector is logged in with
  name              TEXT NOT NULL DEFAULT '',
  version           TEXT NOT NULL DEFAULT '',
  last_seen_at      TEXT NOT NULL DEFAULT '',
  pending_command   TEXT NOT NULL DEFAULT '',     -- '' | 'relink' (handed out once)
  switch_on_open    INTEGER NOT NULL DEFAULT 0    -- 1 = the next number that opens becomes the current one (set by relink)
);
INSERT INTO connector (id) VALUES (1);

-- messages: new status 'queued' (waiting for the connector) and media_ref (file in the media table).
-- SQLite cannot change a CHECK constraint, so the table is rebuilt (nothing references messages).
CREATE TABLE messages_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  number_id   INTEGER REFERENCES wa_numbers(id),
  ext_msg_id  TEXT UNIQUE,
  type        TEXT NOT NULL DEFAULT 'text'
              CHECK (type IN ('text', 'voice', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'reaction', 'other')),
  body        TEXT NOT NULL DEFAULT '',
  media_id    TEXT NOT NULL DEFAULT '',
  media_url   TEXT NOT NULL DEFAULT '',
  media_mime  TEXT NOT NULL DEFAULT '',
  caption     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  from_app    INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  media_ref   TEXT NOT NULL DEFAULT ''             -- id in the media table (connector files and voice/photos sent from the CRM)
);
INSERT INTO messages_new (id, contact_id, direction, number_id, ext_msg_id, type, body, media_id, media_url, media_mime, caption, status, from_app, ts, created_at)
  SELECT id, contact_id, direction, number_id, ext_msg_id, type, body, media_id, media_url, media_mime, caption, status, from_app, ts, created_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_messages_contact ON messages(contact_id, ts);

CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  number_id   INTEGER REFERENCES wa_numbers(id),
  to_ext      TEXT NOT NULL,                      -- recipient (digits, as stored in contacts.ext_id)
  type        TEXT NOT NULL CHECK (type IN ('text', 'voice', 'image')),
  text        TEXT NOT NULL DEFAULT '',           -- message text / image caption
  media_ref   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  error       TEXT NOT NULL DEFAULT '',
  ext_msg_id  TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON outbox(status, id);

-- Small files (voice notes, photos, stickers, documents), at most 1.5 MB each: D1 rows are limited to ~2 MB.
CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_media_created ON media(created_at);

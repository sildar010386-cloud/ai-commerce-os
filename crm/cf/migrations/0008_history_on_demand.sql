-- Loading older WhatsApp messages on demand (the way WhatsApp Web does it) + connector diagnostics.
--   wa_jid                the chat id as WhatsApp knows it ("<digits>@s.whatsapp.net" or "<digits>@lid"), last one seen in an event; '' = derive from ext_id
--   history_requested_at  when the last «load older messages» request was queued
--   history_answered_at   when the phone answered it (or it failed); a request is "pending" while requested_at > answered_at (for 5 min)
--   history_done          1 = the phone has nothing older (an answer brought no messages older than the anchor)
ALTER TABLE contacts ADD COLUMN wa_jid TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN history_requested_at TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN history_answered_at TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN history_done INTEGER NOT NULL DEFAULT 0;

-- The last CRM rejection the connector reported (shown in Settings -> Подключение WhatsApp).
ALTER TABLE connector ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE connector ADD COLUMN last_error_at TEXT NOT NULL DEFAULT '';

-- outbox.type gets 'history' (request for older messages; the JSON payload is kept in `text`).
-- SQLite cannot change a CHECK constraint, so the table is rebuilt (nothing references outbox).
CREATE TABLE outbox_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  number_id   INTEGER REFERENCES wa_numbers(id),
  to_ext      TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('text', 'voice', 'image', 'history')),
  text        TEXT NOT NULL DEFAULT '',
  media_ref   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  error       TEXT NOT NULL DEFAULT '',
  ext_msg_id  TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  waveform    TEXT NOT NULL DEFAULT ''
);
INSERT INTO outbox_new (id, contact_id, message_id, number_id, to_ext, type, text, media_ref, status, error, ext_msg_id, attempts, created_at, updated_at, seconds, waveform)
  SELECT id, contact_id, message_id, number_id, to_ext, type, text, media_ref, status, error, ext_msg_id, attempts, created_at, updated_at, seconds, waveform FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX idx_outbox_status ON outbox(status, id);
CREATE INDEX idx_outbox_history ON outbox(type, created_at);

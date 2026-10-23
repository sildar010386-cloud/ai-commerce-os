-- Kazpost registry import: when the track message was sent to the customer (ISO time, '' = not sent yet).
-- The message template and the tracking link live in the existing `settings` table (keys track_msg, track_url).
ALTER TABLE orders ADD COLUMN track_sent_at TEXT NOT NULL DEFAULT '';

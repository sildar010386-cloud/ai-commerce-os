-- WhatsApp @lid contacts. WhatsApp hides the phone number of some chats behind an anonymous id ("lid", 14-15 digits).
-- Until now such a chat was stored with phone = the lid digits and shown as a fake "+22664861229131".
--   id_kind 'pn'  = ext_id is a real phone number;  'lid' = ext_id is an anonymous id, phone stays empty.
--   wa_alias      = lid -> real phone, learned from history sync / contacts / live messages; used to merge a lid contact into the
--                   phone contact (and to route later lid-only events to the phone contact).
ALTER TABLE contacts ADD COLUMN id_kind TEXT NOT NULL DEFAULT 'pn';

CREATE TABLE wa_alias (
  lid         TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_wa_alias_phone ON wa_alias(phone);

-- Existing rows: a WhatsApp chat id of 14+ digits is a lid (E.164 numbers have at most 15 digits and real ones of 14-15 are
-- practically nonexistent). The connector corrects any miss at run time (events carry the lid).
UPDATE contacts SET id_kind = 'lid', phone = '' WHERE channel = 'whatsapp' AND length(ext_id) >= 14;

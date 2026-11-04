-- Voice notes sent from the CRM: duration (seconds) and the 64-value waveform (base64 of 64 bytes, 0..100) computed in the browser.
-- WhatsApp draws a flat line for a voice note without a waveform. Empty / 0 = unknown (the connector then sends as before).
ALTER TABLE outbox ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN waveform TEXT NOT NULL DEFAULT '';

// Pure mapping from Baileys structures to the normalized events that the CRM ingests (crm/cf/src/wa.js normalizeInboxEvents).
// No I/O, no Baileys import: everything here is unit-testable with plain objects.
//
// Event shape (numberPhone is filled by the caller via ctx.ownPhone):
//   {kind:'message'|'echo'|'history', numberPhone, waId, profileName, direction:'in'|'out',
//    msg:{id, ts (epoch seconds), type, body, mime, caption, referral, mediaRef}}
//   {kind:'status', numberPhone, id, status:'sent'|'delivered'|'read'|'failed', ts}

export const MAX_MEDIA_BYTES = 1.5 * 1024 * 1024;
export const NOTE_BIG = 'файл больше 1,5 МБ — откройте на телефоне';
export const NOTE_VIDEO = 'видео — откройте на телефоне';
export const NOTE_HISTORY = 'вложение из истории — откройте на телефоне';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const digits = (v) => str(v).replace(/\D/g, '');

// protobuf numbers may arrive as number, string, Long ({low, high}) or an object with toNumber().
export function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = Number(v); return isFinite(n) ? n : 0; }
  if (typeof v.toNumber === 'function') { try { return v.toNumber(); } catch (e) { return 0; } }
  if (isObj(v) && typeof v.low === 'number') {
    const hi = typeof v.high === 'number' ? v.high : 0;
    return (hi >>> 0) * 4294967296 + (v.low >>> 0);
  }
  return 0;
}

const userPart = (jid) => str(jid).split('@')[0].split(':')[0];
const serverPart = (jid) => { const i = str(jid).indexOf('@'); return i < 0 ? '' : str(jid).slice(i + 1).toLowerCase(); };

// Which 1:1 chat does this key belong to?  -> {waId, lid} or null for groups, status, newsletters, broadcast lists, anything odd.
// lid=true means only the anonymous @lid address is known (no phone number available), waId is then the lid user part.
export function chatIdOf(key) {
  if (!isObj(key)) return null;
  const jid = str(key.remoteJid);
  const server = serverPart(jid);
  if (!server) return null;
  if (server === 'g.us' || server === 'newsletter' || server === 'broadcast' || server.endsWith('broadcast') || jid === 'status@broadcast') return null;
  if (server === 's.whatsapp.net' || server === 'c.us') {
    const d = digits(userPart(jid));
    return d.length >= 5 && d.length <= 20 ? { waId: d, lid: false } : null;
  }
  if (server === 'lid') {
    const alts = [key.remoteJidAlt, key.senderPn, key.participantPn].map(str);
    for (const a of alts) {
      const sv = serverPart(a);
      if (sv === 's.whatsapp.net' || sv === 'c.us') {
        const d = digits(userPart(a));
        if (d.length >= 5 && d.length <= 20) return { waId: d, lid: false, lidUser: userPart(jid) };
      }
    }
    const d = digits(userPart(jid));
    return d.length >= 5 ? { waId: d, lid: true, lidUser: userPart(jid) } : null;
  }
  return null;
}

// Peels the wrappers around the real content (disappearing messages, view-once, documents with caption, edits).
export function unwrap(content) {
  let c = isObj(content) ? content : null;
  for (let i = 0; c && i < 6; i++) {
    const w = c.ephemeralMessage || c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension ||
      c.documentWithCaptionMessage || c.deviceSentMessage || c.editedMessage;
    if (isObj(w) && isObj(w.message)) c = w.message; else break;
  }
  return c;
}

function referralOf(ctx) {
  const ad = isObj(ctx) && isObj(ctx.externalAdReply) ? ctx.externalAdReply : null;
  if (!ad) return null;
  return { source_url: str(ad.sourceUrl), source_type: 'ad', source_id: str(ad.sourceId), headline: str(ad.title), body: str(ad.body) };
}

// Returns {type, body, caption, mime, referral, media: null | {kind, size, mime}} or null when the message must be skipped.
export function describeContent(content) {
  const c = unwrap(content);
  if (!c) return null;
  const out = (type, extra) => Object.assign({ type, body: '', caption: '', mime: '', referral: null, media: null }, extra);
  if (isObj(c.protocolMessage) || isObj(c.senderKeyDistributionMessage) || isObj(c.messageContextInfo) && Object.keys(c).length === 1) return null;
  if (typeof c.conversation === 'string') return out('text', { body: c.conversation });
  if (isObj(c.extendedTextMessage)) {
    const x = c.extendedTextMessage;
    return out('text', { body: str(x.text), referral: referralOf(x.contextInfo) });
  }
  if (isObj(c.imageMessage)) {
    const x = c.imageMessage;
    return out('image', { caption: str(x.caption), mime: str(x.mimetype), referral: referralOf(x.contextInfo), media: { kind: 'image', size: toNum(x.fileLength), mime: str(x.mimetype) } });
  }
  if (isObj(c.videoMessage)) {
    const x = c.videoMessage;
    return out('video', { caption: str(x.caption), mime: str(x.mimetype), referral: referralOf(x.contextInfo), media: { kind: 'video', size: toNum(x.fileLength), mime: str(x.mimetype) } });
  }
  if (isObj(c.audioMessage)) {
    const x = c.audioMessage, voice = x.ptt === true;
    return out(voice ? 'voice' : 'audio', { mime: str(x.mimetype), media: { kind: voice ? 'voice' : 'audio', size: toNum(x.fileLength), mime: str(x.mimetype) } });
  }
  if (isObj(c.documentMessage)) {
    const x = c.documentMessage;
    return out('document', { caption: str(x.caption) || str(x.fileName), mime: str(x.mimetype), media: { kind: 'document', size: toNum(x.fileLength), mime: str(x.mimetype) } });
  }
  if (isObj(c.stickerMessage)) {
    const x = c.stickerMessage;
    return out('sticker', { mime: str(x.mimetype), media: { kind: 'sticker', size: toNum(x.fileLength), mime: str(x.mimetype) } });
  }
  const loc = isObj(c.locationMessage) ? c.locationMessage : isObj(c.liveLocationMessage) ? c.liveLocationMessage : null;
  if (loc) {
    const coords = loc.degreesLatitude != null && loc.degreesLongitude != null ? `${loc.degreesLatitude},${loc.degreesLongitude}` : '';
    return out('location', { body: [str(loc.name), str(loc.address), coords].filter(Boolean).join(' · ') });
  }
  if (isObj(c.reactionMessage)) {
    const emoji = str(c.reactionMessage.text);
    if (!emoji) return null; // reaction removed
    return out('reaction', { body: emoji });
  }
  if (isObj(c.contactMessage)) return out('other', { body: 'Контакт: ' + str(c.contactMessage.displayName) });
  if (isObj(c.contactsArrayMessage)) return out('other', { body: 'Контакты: ' + str(c.contactsArrayMessage.displayName) });
  if (isObj(c.buttonsResponseMessage)) return out('text', { body: str(c.buttonsResponseMessage.selectedDisplayText || c.buttonsResponseMessage.selectedButtonId) });
  if (isObj(c.listResponseMessage)) return out('text', { body: str(c.listResponseMessage.title || (c.listResponseMessage.singleSelectReply || {}).selectedRowId) });
  if (isObj(c.templateButtonReplyMessage)) return out('text', { body: str(c.templateButtonReplyMessage.selectedDisplayText) });
  if (isObj(c.pollCreationMessage) || isObj(c.pollCreationMessageV3)) return out('other', { body: 'Опрос: ' + str((c.pollCreationMessage || c.pollCreationMessageV3).name) });
  // Known "noise" with no user-visible content.
  if (Object.keys(c).every((k) => /^(messageContextInfo|pollUpdateMessage|keepInChatMessage|encReactionMessage|call|peerDataOperationRequestMessage|requestPhoneNumberMessage|lottieStickerMessage)$/.test(k))) return null;
  return out('other', { body: '' });
}

// One WAMessage -> {event, media} or null. ctx: {ownPhone, kind: 'message'|'history'|'auto', allowAppend}
//   kind 'auto': fromMe -> 'echo', otherwise 'message'.
export function mapMessage(m, ctx) {
  try {
    if (!isObj(m) || !isObj(m.key) || !m.message) return null;
    const chat = chatIdOf(m.key);
    if (!chat) return null;
    const d = describeContent(m.message);
    if (!d) return null;
    const fromMe = m.key.fromMe === true;
    const kind = ctx.kind === 'history' ? 'history' : fromMe ? 'echo' : 'message';
    const ts = toNum(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    const msg = { id: str(m.key.id), ts, type: d.type, body: d.body, mime: d.mime, caption: d.caption, referral: d.referral, mediaRef: '' };
    let media = d.media;
    if (media) {
      // Video is never mirrored to the CRM; big files and history attachments get a note instead of a file.
      if (media.kind === 'video') { msg.body = NOTE_VIDEO; media = null; }
      else if (ctx.kind === 'history') { msg.body = NOTE_HISTORY; media = null; }
      else if (media.size > MAX_MEDIA_BYTES) { msg.body = NOTE_BIG; media = null; }
    }
    const event = {
      kind, numberPhone: str(ctx.ownPhone), waId: chat.waId, profileName: fromMe ? '' : str(m.pushName).slice(0, 200),
      direction: fromMe ? 'out' : 'in', msg
    };
    return { event, media, chat };
  } catch (e) {
    return null;
  }
}

// proto.WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED
export function statusName(code) {
  switch (code) {
    case 0: return 'failed';
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4: case 5: return 'read';
    default: return '';
  }
}

// messages.update entries -> status events (only our own outgoing messages in 1:1 chats).
export function mapUpdates(updates, ownPhone) {
  const out = [];
  for (const u of Array.isArray(updates) ? updates : []) {
    try {
      if (!isObj(u) || !isObj(u.key) || u.key.fromMe !== true || !u.key.id || !chatIdOf(u.key)) continue;
      const st = statusName(isObj(u.update) ? u.update.status : undefined);
      if (!st) continue;
      out.push({ kind: 'status', numberPhone: str(ownPhone), id: str(u.key.id), status: st, ts: Math.floor(Date.now() / 1000) });
    } catch (e) { /* skip */ }
  }
  return out;
}

// message-receipt.update entries -> status events.
export function mapReceipts(receipts, ownPhone) {
  const out = [];
  for (const r of Array.isArray(receipts) ? receipts : []) {
    try {
      if (!isObj(r) || !isObj(r.key) || r.key.fromMe !== true || !r.key.id || !chatIdOf(r.key) || !isObj(r.receipt)) continue;
      const rc = r.receipt;
      const read = toNum(rc.readTimestamp) || toNum(rc.playedTimestamp);
      const delivered = toNum(rc.receiptTimestamp);
      if (read) out.push({ kind: 'status', numberPhone: str(ownPhone), id: str(r.key.id), status: 'read', ts: read });
      else if (delivered) out.push({ kind: 'status', numberPhone: str(ownPhone), id: str(r.key.id), status: 'delivered', ts: delivered });
    } catch (e) { /* skip */ }
  }
  return out;
}

// History batches: keep the last `days` days, newest `cap` messages, return them oldest first.
export function selectHistory(messages, { days = 180, cap = 5000, now = Date.now() } = {}) {
  const min = Math.floor(now / 1000) - days * 86400;
  const list = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const ts = isObj(m) ? toNum(m.messageTimestamp) : 0;
    if (ts >= min) list.push(m);
  }
  list.sort((a, b) => toNum(b.messageTimestamp) - toNum(a.messageTimestamp));
  return list.slice(0, cap).reverse();
}

export function phoneOfJid(jid) {
  return digits(userPart(jid));
}

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
// A message WhatsApp delivered but this computer could not decrypt (Baileys gives a CIPHERTEXT stub without content). The chat
// still goes to the CRM, so a new client is never lost; the CRM replaces this text when the real message arrives (same id).
export const NOTE_UNDECRYPTED = 'Сообщение не расшифровалось — откройте этот чат на телефоне';
export const STUB_CIPHERTEXT = 2;   // proto.WebMessageInfo.StubType.CIPHERTEXT (1 is REVOKE; test/map.test.js checks it against Baileys)

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
    // sender_pn / participant_pn name the SENDER: for our own messages that is our own number, not the customer's
    const alts = (key.fromMe === true ? [key.remoteJidAlt] : [key.remoteJidAlt, key.senderPn, key.participantPn]).map(str);
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

// The chat as WhatsApp addresses it (what fetchMessageHistory needs): the lid when the key was a lid, else the phone.
export const chatJidOf = (chat) => (chat.lidUser ? chat.lidUser + '@lid' : chat.waId + '@s.whatsapp.net');

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
    if (!isObj(m) || !isObj(m.key)) return null;
    if (!m.message) return mapUndecrypted(m, ctx);
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
    if (chat.lidUser) event.lid = chat.lidUser;   // anonymous id of the chat (== waId when the phone is unknown)
    event.chatJid = chatJidOf(chat);                      // the chat as WhatsApp addresses it: the CRM needs it to ask the phone for older messages
    return { event, media, chat };
  } catch (e) {
    return null;
  }
}

// Is this a message WhatsApp delivered that could not be decrypted here? -> the reason text, else ''.
export function undecryptedReason(m) {
  if (!isObj(m) || m.message || toNum(m.messageStubType) !== STUB_CIPHERTEXT) return '';
  const p = Array.isArray(m.messageStubParameters) ? m.messageStubParameters : [];
  return str(p[0] || 'unknown').slice(0, 80);
}

// A CIPHERTEXT stub of an incoming 1:1 message -> a placeholder 'message' event. Stubs come only from real deliveries (live or the
// offline queue), never from a history sync, so even an 'append' stub is a client writing to us; older than 14 days = ignored.
export const UNDECRYPTED_MAX_AGE_S = 14 * 86400;
function mapUndecrypted(m, ctx) {
  if (!undecryptedReason(m) || m.key.fromMe === true) return null;
  const chat = chatIdOf(m.key);
  if (!chat || (ctx.ownPhone && chat.waId === digits(ctx.ownPhone)) || (ctx.ownLid && chat.lidUser === str(ctx.ownLid))) return null;   // our own phone
  const nowS = Math.floor((ctx.now || Date.now()) / 1000);
  const ts = toNum(m.messageTimestamp) || nowS;
  if (ts < nowS - UNDECRYPTED_MAX_AGE_S) return null;
  const event = {
    kind: 'message', numberPhone: str(ctx.ownPhone), waId: chat.waId, profileName: str(m.pushName).slice(0, 200), direction: 'in',
    msg: { id: str(m.key.id), ts, type: 'other', body: NOTE_UNDECRYPTED, mime: '', caption: '', referral: null, mediaRef: '', undecrypted: true }
  };
  if (chat.lidUser) event.lid = chat.lidUser;
  event.chatJid = chatJidOf(chat);
  return { event, media: null, chat, undecrypted: true };
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

// History batches: keep the last `days` days, at most `perChat` newest messages of each chat (so that many chats appear, not a few
// chats with a deep history) and at most `cap` newest messages overall. Returns them grouped by chat, oldest first inside a chat.
// A chat is the 1:1 chat the key resolves to (the same person under @lid and under the phone is ONE chat); a message id is taken once.
export const HISTORY_CAP = 14000, HISTORY_PER_CHAT = 1000, HISTORY_DAYS = 365;
export function selectHistory(messages, { days = HISTORY_DAYS, cap = HISTORY_CAP, perChat = HISTORY_PER_CHAT, now = Date.now() } = {}) {
  const min = Math.floor(now / 1000) - days * 86400;
  const chatKey = (m) => { const c = m && chatIdOf(m.key); return c ? c.waId : str(m && m.key && m.key.remoteJid); };
  const list = [], seen = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const ts = isObj(m) ? toNum(m.messageTimestamp) : 0;
    if (ts < min) continue;
    const id = isObj(m.key) ? str(m.key.id) : '';
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    list.push(m);
  }
  list.sort((a, b) => toNum(b.messageTimestamp) - toNum(a.messageTimestamp));
  const count = new Map(), kept = [];
  for (const m of list) {
    const k = chatKey(m);
    const n = count.get(k) || 0;
    if (n >= perChat) continue;
    count.set(k, n + 1);
    kept.push(m);
    if (kept.length >= cap) break;
  }
  // grouped by chat (first appearance = newest chat first), oldest first inside
  const order = new Map();
  kept.forEach((m) => { const k = chatKey(m); if (!order.has(k)) order.set(k, order.size); });
  return kept.reverse().sort((a, b) => order.get(chatKey(a)) - order.get(chatKey(b)));
}

// Names and lid->phone links out of a messaging-history.set / contacts.upsert payload (and the decoded HistorySync blob).
//   chats: {id, pnJid, lidJid, name}; contacts: {id, lid, jid, phoneNumber, name, notify}; mappings: [{pnJid, lidJid}] (HistorySync.phoneNumberToLidMappings)
// -> {names: Map(waId -> name), lidPn: Map(lidUser -> phone digits)}
export function readContacts({ chats, contacts, mappings } = {}) {
  const names = new Map(), lidPn = new Map();
  const phoneOf = (jid) => { const sv = serverPart(jid); return (sv === 's.whatsapp.net' || sv === 'c.us') ? digits(userPart(jid)) : ''; };
  const lidOf = (jid) => (serverPart(jid) === 'lid' ? userPart(jid) : '');
  const put = (ids, name) => {
    const n = str(name).trim().slice(0, 200);
    let phone = '', lid = '';
    for (const id of ids) { phone = phone || phoneOf(id); lid = lid || lidOf(id); }
    if (phone && lid && phone !== lid && phone.length >= 7 && phone.length <= 15) lidPn.set(lid, phone);
    if (n) { if (phone) names.set(phone, n); else if (lid) names.set(lid, n); }
  };
  // a bare phone number field ("+7 701 ...") counts as a jid
  const pnField = (v) => { const d = digits(v); return d && !/@/.test(str(v)) ? d + '@s.whatsapp.net' : str(v); };
  for (const c of Array.isArray(contacts) ? contacts : []) {
    if (isObj(c)) put([c.id, c.jid, c.lid, pnField(c.phoneNumber)], c.name || c.notify || c.verifiedName);
  }
  for (const c of Array.isArray(chats) ? chats : []) {
    if (isObj(c)) put([c.id, c.pnJid, c.lidJid], c.name || c.displayName);
  }
  for (const x of Array.isArray(mappings) ? mappings : []) {
    if (isObj(x)) put([x.pnJid, x.lidJid], '');
  }
  return { names, lidPn };
}

// The phone behind a @lid key of a live message (stanza attrs sender_pn / participant_pn, or remoteJidAlt): {lid, phone} or null.
export function lidPairOfKey(key) {
  if (!isObj(key) || serverPart(key.remoteJid) !== 'lid') return null;
  const alts = key.fromMe === true ? [key.remoteJidAlt] : [key.remoteJidAlt, key.senderPn];
  for (const a of alts) {
    const sv = serverPart(a);
    if (sv === 's.whatsapp.net' || sv === 'c.us') {
      const phone = digits(userPart(a));
      if (phone.length >= 7 && phone.length <= 15) return { lid: userPart(key.remoteJid), phone };
    }
  }
  return null;
}

export function phoneOfJid(jid) {
  return digits(userPart(jid));
}

// Conversations of a messaging-history.set / HistorySync blob -> 'chat' events (a 1:1 chat of the phone, with or without messages in
// this batch): {kind:'chat', waId, lid?, chatJid, profileName, lastTs (epoch s)}. The CRM creates the contact when it does not exist,
// so the chat shows in the list even though WhatsApp sends its messages only on demand.
// chat: {id, pnJid, lidJid, name, displayName, conversationTimestamp, lastMsgTimestamp}
export function mapChats(chats, ownPhone, lidPn = new Map()) {
  const out = [];
  for (const c of Array.isArray(chats) ? chats : []) {
    try {
      if (!isObj(c)) continue;
      const id = str(c.id);
      const isLid = serverPart(id) === 'lid';
      const alt = isLid ? str(c.pnJid) || (lidPn.get(userPart(id)) ? lidPn.get(userPart(id)) + '@s.whatsapp.net' : '') : '';
      const ch = chatIdOf({ remoteJid: id, remoteJidAlt: alt, fromMe: false });
      if (!ch) continue;
      const lid = ch.lidUser || (serverPart(id) !== 'lid' && serverPart(c.lidJid) === 'lid' ? userPart(c.lidJid) : '');
      const ts = toNum(c.conversationTimestamp) || toNum(c.lastMsgTimestamp);
      if (!ts && !str(c.name || c.displayName).trim()) continue;   // nothing known about this entry: not worth a contact
      const ev = { kind: 'chat', numberPhone: str(ownPhone), waId: ch.waId, chatJid: chatJidOf(ch), profileName: str(c.name || c.displayName).trim().slice(0, 200), lastTs: ts };
      if (lid) ev.lid = lid;
      out.push(ev);
    } catch (e) { /* skip */ }
  }
  return out;
}

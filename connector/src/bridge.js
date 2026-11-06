// The connector core: owns the WhatsApp socket, turns its events into CRM events, executes the CRM outbox.
// All I/O is injected (socket factory, CRM client, queue, ffmpeg, clock), so it is testable with a fake socket.
import fs from 'node:fs';
import path from 'node:path';
import { short, describeUpdate } from './safelog.js';
import { mapMessage, undecryptedReason, mapUpdates, mapReceipts, selectHistory, mapChats, readContacts, lidPairOfKey, unwrap, toNum, phoneOfJid, MAX_MEDIA_BYTES, chatIdOf, HISTORY_CAP, HISTORY_DAYS, HISTORY_PER_CHAT } from './map.js';

// base64 of 64 bytes (0..100) -> Uint8Array, otherwise null
export function parseWave(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 64 || buf.some((x) => x > 100)) return null;
  return new Uint8Array(buf);
}

const LOGGED_OUT = 401, FORBIDDEN = 403, REPLACED = 440, RESTART_REQUIRED = 515;
const REPLACED_BACKOFF_MS = 30000;
const NOTE_MEDIA_FAIL = 'не удалось загрузить файл — откройте на телефоне';
const HISTORY_BATCH = 15;
const SYNC_ON_DEMAND = 6;                 // proto HistorySyncType.ON_DEMAND
const ON_DEMAND_PER_CHAT = 1000;          // one on-demand answer holds one page (<= 50) of one chat
const EMPTY_CHATS_CAP = 3000;             // chats WITHOUT messages that a pairing sends to the CRM (one D1 row each)
const REQ_KEEP_MS = 15 * 60000;           // an on-demand request nobody answered is forgotten after this

export function createBridge({
  crm, queue, makeSocket, wipeAuth, renderQr, downloadMedia, downloadHistory, prepareVoice, version, stateDir, voiceHint = { current: null },
  log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random,
  now = Date.now, watchdogMs = 5 * 60000, watchTickMs = 15000, sleepGapMs = 60000, stuckMs = 3 * 60000,
  blobWaitMs = 60000, finalPassMs = 45000
}) {
  let gen = 0, sock = null, state = 'connecting', ownPhone = '', ownName = '', ownLid = '';
  let lastCommandId = '';
  const info = (m) => { log.info && log.info(m); };
  // A client id in the log: only the last 4 digits (the log may be shown to someone helping; numbers stay private).
  const maskId = (id) => { const d = String(id || '').replace(/\D/g, ''); return d.length > 4 ? '***' + d.slice(-4) : d || '?'; };
  let reconnectN = 0, relinking = false, stopped = false, historyCount = 0, pollTimer = null, beatTimer = null, watchTimer = null;
  let lastActivity = now(), lastTick = now(), stateSince = now(), wsHooked = false;
  const sentIds = new Map();      // message ids we sent ourselves (their echo must not be reported as "sent from the phone")
  const doneOutbox = new Map();   // outbox id -> extMsgId, protects against double sending when an ack got lost
  const lids = new Set();
  const pendingBlobs = new Set();  // history-sync blobs being downloaded by harvestHistory: messaging-history.set waits for them
  const historyReqs = new Map();   // on-demand request id -> {outboxId, chatJid, anchorTs, at}
  const chatsSent = new Set();     // chats already announced to the CRM without messages
  let finalTimer = null, emptyChats = 0;
  const lidPn = new Map();        // anonymous @lid user -> real phone number (history, contacts, live messages); kept in lidmap.json
  const names = new Map();        // wa id -> name from the phone book / push names
  const lidFile = stateDir ? path.join(stateDir, 'lids.json') : '';
  const mapFile = stateDir ? path.join(stateDir, 'lidmap.json') : '';
  try {
    if (mapFile && fs.existsSync(mapFile)) {
      const o = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) if (/^\d{5,20}$/.test(k) && /^\d{7,15}$/.test(String(v))) lidPn.set(k, String(v));
    }
  } catch (e) { /* ignore */ }
  // Messages that reach the phone while this connector is offline (laptop off / asleep) are delivered on reconnect as
  // messages.upsert type 'append' (Baileys: node.attrs.offline). They are NEW messages, not history: anything newer than the
  // last moment we were online is handled as live (source detection, unread). The moment is kept in online.json.
  const onlineFile = stateDir ? path.join(stateDir, 'online.json') : '';
  let lastOnline = 0, liveSince = 0;
  try { if (onlineFile && fs.existsSync(onlineFile)) lastOnline = Number(JSON.parse(fs.readFileSync(onlineFile, 'utf8')).at) || 0; } catch (e) { lastOnline = 0; }
  const markOnline = () => {
    lastOnline = now();
    try { if (onlineFile) fs.writeFileSync(onlineFile, JSON.stringify({ at: lastOnline })); } catch (e) { /* ignore */ }
  };
  const forgetOnline = () => {
    lastOnline = 0; liveSince = 0;
    try { if (onlineFile && fs.existsSync(onlineFile)) fs.unlinkSync(onlineFile); } catch (e) { /* ignore */ }
  };
  const OFFLINE_MARGIN_MS = 15 * 60000;
  const isLiveUpsert = (type, m) => {
    if (type === 'notify') return true;
    if (type !== 'append' || !liveSince) return false;
    const ts = toNum(m && m.messageTimestamp) * 1000;
    return ts > 0 && ts >= liveSince - OFFLINE_MARGIN_MS;
  };
  const saveMap = () => {
    try {
      if (!mapFile) return;
      const tmp = mapFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(lidPn)));
      fs.renameSync(tmp, mapFile);
    } catch (e) { /* ignore */ }
  };
  try { if (lidFile && fs.existsSync(lidFile)) JSON.parse(fs.readFileSync(lidFile, 'utf8')).forEach((x) => lids.add(String(x))); } catch (e) { /* ignore */ }

  const rememberLid = (waId) => {
    if (lids.has(waId)) return;
    lids.add(waId);
    try { if (lidFile) fs.writeFileSync(lidFile, JSON.stringify([...lids].slice(-5000))); } catch (e) { /* ignore */ }
  };
  const trim = (map) => { while (map.size > 500) map.delete(map.keys().next().value); };
  const postState = async (extra) => {
    try {
      const le = queue && typeof queue.lastError === 'function' ? { lastError: queue.lastError() } : {};
      await crm.state(Object.assign({ state, version }, ownPhone && state === 'open' ? { phone: ownPhone, name: ownName } : {}, le, extra));
    }
    catch (e) { log.warn && log.warn('state post failed: ' + e.message); }
  };
  const readOwn = () => {
    const u = sock && sock.user;
    if (u && u.id) { ownPhone = phoneOfJid(u.id); ownName = String(u.name || u.verifiedName || ''); }
    if (u && u.lid) ownLid = String(u.lid).split('@')[0].split(':')[0];
  };

  /* ---------- connection lifecycle ---------- */
  async function connect() {
    if (stopped) return;
    const my = ++gen;
    let s;
    try { s = await makeSocket(); }
    catch (e) { log.error && log.error('socket start failed: ' + e.message); return scheduleReconnect(my); }
    if (my !== gen) { try { s.end && s.end(undefined); } catch (e) { /* ignore */ } return; }
    sock = s;
    lastActivity = now(); stateSince = now();
    const guard = (fn) => (arg) => { if (my !== gen) return; Promise.resolve().then(() => fn(arg)).catch((e) => log.error && log.error('handler failed: ' + (e && e.message))); };
    s.ev.on('connection.update', guard((u) => onConnection(my, u)));
    s.ev.on('messages.upsert', guard(onUpsert));
    s.ev.on('messaging-history.set', guard(onHistory));
    s.ev.on('contacts.upsert', guard(onContacts));
    s.ev.on('contacts.update', guard(onContacts));
    s.ev.on('chats.phoneNumberShare', guard((x) => { // a customer shared the phone behind his lid
      const r = readContacts({ contacts: [{ id: x && x.lid, jid: x && x.jid }] });
      readOwn();
      return announce(learnPairs([...r.lidPn].map(([lid, phone]) => ({ lid, phone }))));
    }));
    s.ev.on('messages.update', guard((u) => emit(mapUpdates(u, ownPhone))));
    s.ev.on('message-receipt.update', guard((u) => emit(mapReceipts(u, ownPhone))));
    // Any frame from WhatsApp (the keep-alive answers come every ~30 s) proves the connection is alive.
    wsHooked = !!(s.ws && typeof s.ws.on === 'function');
    if (wsHooked) for (const ev of ['message', 'ping', 'pong']) s.ws.on(ev, guard(() => { lastActivity = now(); }));
  }

  // The socket is dead but nobody told us (laptop slept, Wi-Fi changed, router dropped the connection): start over.
  async function forceReconnect(reason) {
    if (stopped || relinking) return;
    log.warn && log.warn('watchdog: reconnecting (' + reason + ')');
    gen++;
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
    reconnectN = 0; state = 'closed'; stateSince = now();
    await connect();
  }
  let seenState = state;
  function watchdogTick() {
    const t = now(), gap = t - lastTick;
    if (state !== seenState) { seenState = state; stateSince = t; }
    lastTick = t;
    if (stopped || relinking) return;
    if (gap > sleepGapMs) return forceReconnect('woke up after ' + Math.round(gap / 1000) + ' s');
    if (state === 'open' && wsHooked && t - lastActivity > watchdogMs) return forceReconnect('no frames for ' + Math.round((t - lastActivity) / 1000) + ' s');
    if ((state === 'connecting' || state === 'closed') && t - stateSince > stuckMs) return forceReconnect('stuck in ' + state);
  }

  async function scheduleReconnect(my, ms) {
    if (stopped || my !== gen) return;
    const delay = ms != null ? ms : Math.min(60000, 2000 * 2 ** Math.min(reconnectN, 5));
    reconnectN++;
    info(`conn: reconnect in ${Math.round(delay / 1000)} s (attempt ${reconnectN})`);
    await sleep(delay);
    if (stopped || my !== gen) return;
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
    return connect();
  }

  async function onConnection(my, u) {
    info('conn: ' + describeUpdate(u));
    if (u.qr) {
      state = 'qr';
      let png = '';
      try { png = await renderQr(u.qr); } catch (e) { log.error && log.error('qr render failed'); }
      if (png) await postState({ qr: png });
    }
    if (u.connection === 'connecting' && state !== 'qr') state = 'connecting';
    if (u.connection === 'open') {
      readOwn();
      info(`conn: open as +${ownPhone || '?'}`);
      state = 'open'; reconnectN = 0; historyCount = 0;
      liveSince = lastOnline;          // 0 right after pairing: what WhatsApp then sends is history
      if (liveSince) info(`conn: messages since ${new Date(liveSince).toISOString()} (offline period) count as new`);
      markOnline();
      await postState();
      queue.flush();
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect && u.lastDisconnect.error;
      const code = err && err.output && err.output.statusCode;
      if (relinking) return;
      if (code === LOGGED_OUT) return freshStart(my, 'logged_out');
      if (code === REPLACED) {
        // Another connector (or WhatsApp Web session of this device) took the session over: do not fight it, wait.
        log.error && log.error(`conn: SESSION REPLACED (440): another copy of the program is using this WhatsApp session; waiting ${REPLACED_BACKOFF_MS / 1000} s`);
        state = 'replaced';
        await postState({ reason: code });
        return scheduleReconnect(my, REPLACED_BACKOFF_MS);
      }
      if (code === FORBIDDEN) { state = 'banned'; await postState({ reason: code }); return scheduleReconnect(my, 5 * 60000); }
      state = 'closed';
      await postState({ reason: code || 0 });
      return scheduleReconnect(my, code === RESTART_REQUIRED ? 500 : undefined);
    }
  }

  // The phone removed this linked device (or the number is gone): forget the session and show a new QR.
  async function freshStart(my, reason) {
    info(`conn: ${reason}: wiping the session, a new QR will follow`);
    state = reason; ownPhone = ''; ownName = '';
    await postState();
    try { await wipeAuth(); } catch (e) { log.error && log.error('wipe auth failed: ' + e.message); }
    forgetOnline();
    return scheduleReconnect(my, 1000);
  }

  async function relink(commandId = '') {
    if (relinking) return;
    relinking = true; gen++;
    info(`relink: command received${commandId ? ' (' + commandId + ')' : ''}, socket state was ${state}`);
    // Acknowledge first: the CRM keeps the command pending until it hears this (a duplicate process cannot swallow it silently).
    state = 'relinking';
    await postState(commandId ? { commandId } : {});
    try { if (sock && sock.logout) { await Promise.race([sock.logout(), sleep(8000)]); info('relink: logout done'); } }
    catch (e) { info('relink: logout failed (' + short(e && e.message, 100) + '), continuing'); /* the phone may already be gone */ }
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
    forgetOnline();
    try { await wipeAuth(); info('relink: auth wiped'); } catch (e) { log.error && log.error('relink: wipe auth failed: ' + short(e && e.message, 150)); }
    state = 'logged_out'; ownPhone = ''; ownName = ''; reconnectN = 0;
    await postState();
    relinking = false;
    info('relink: starting a new socket (a QR should follow)');
    return connect();
  }

  /* ---------- inbound ---------- */
  async function emit(events) {
    const list = events.filter((e) => e && e.numberPhone);
    if (list.length) await queue.push(list);
  }

  async function withMedia(mapped, m) {
    const { event, media } = mapped;
    if (!media) return event;
    try {
      const buf = await downloadMedia(m, sock);
      if (!buf || !buf.length) throw new Error('empty');
      if (buf.length > MAX_MEDIA_BYTES) { event.msg.body = 'файл больше 1,5 МБ — откройте на телефоне'; return event; }
      const mime = (event.msg.mime || media.mime || 'application/octet-stream');
      const up = await crm.uploadMedia(mime, buf);
      if (up && up.id) event.msg.mediaRef = String(up.id);
      else event.msg.body = NOTE_MEDIA_FAIL;
    } catch (e) {
      log.warn && log.warn('media failed: ' + (e && e.message));
      event.msg.body = NOTE_MEDIA_FAIL;
    }
    return event;
  }

  async function onUpsert(u) {
    readOwn();
    if (!ownPhone) return;
    const min = Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86400;
    let offlineNew = 0;
    const later = [];   // history-like messages: sent together at the end
    // The history-sync notification itself arrives here: Baileys drops the lid -> phone table of that blob, we read it ourselves.
    for (const m0 of u.messages || []) { const hp = harvestHistory(m0); if (hp) hp.catch(() => {}); }
    const pairs = [];
    for (const m0 of u.messages || []) { const p = m0 && lidPairOfKey(m0.key); if (p) pairs.push(p); }
    if (pairs.length) await announce(learnPairs(pairs));
    for (const m0 of u.messages || []) {
      if (m0 && m0.key && m0.key.fromMe && sentIds.has(m0.key.id)) continue;
      const live = isLiveUpsert(u.type, m0);
      if (live && u.type === 'append') offlineNew++;
      const m = withPhone(m0);
      const mapped = mapMessage(m, { ownPhone, ownLid, kind: live ? 'auto' : 'history', allowAppend: live });
      const why = undecryptedReason(m0);
      if (why && m0.key && !m0.key.fromMe) info(`in: ${mapped ? maskId(mapped.event.waId) : '(not a client chat)'} NOT DECRYPTED (${why}), ${u.type}${mapped ? ': placeholder sent' : ''}`);
      if (!mapped) continue;
      if (mapped.chat.lid) rememberLid(mapped.chat.waId);
      if (mapped.undecrypted) { await emit([mapped.event]); continue; }
      if (!live) { if (mapped.event.msg.ts >= min) later.push(mapped.event); continue; }
      // A live message is queued (written to disk) right away, one by one: nothing waits for the media of another message.
      if (mapped.event.kind === 'message') info(`in: ${maskId(mapped.event.waId)} ${mapped.event.msg.type}${u.type === 'append' ? ' (offline)' : ''}`);
      await emit([await withMedia(mapped, m)]);
    }
    if (offlineNew) info(`upsert: ${offlineNew} message(s) received while offline, handled as new`);
    await emit(later);
  }

  // A @lid chat whose phone number we know is stored under the phone (so it is the same client as in the phone's chat list).
  const withPhone = (m) => {
    const key = m && m.key;
    if (!key || typeof key.remoteJid !== 'string' || !key.remoteJid.endsWith('@lid') || key.remoteJidAlt) return m;
    const pn = lidPn.get(key.remoteJid.split('@')[0].split(':')[0]);
    return pn ? Object.assign({}, m, { key: Object.assign({}, key, { remoteJidAlt: pn + '@s.whatsapp.net' }) }) : m;
  };
  // Remembers lid -> phone pairs; returns the NEW ones.
  const learnPairs = (pairs) => {
    const fresh = [];
    for (const { lid, phone } of pairs) {
      if (!lid || !phone || lid === phone || lidPn.get(lid) === phone) continue;
      lidPn.set(lid, phone);
      fresh.push({ lid, phone });
    }
    if (fresh.length) {
      while (lidPn.size > 50000) lidPn.delete(lidPn.keys().next().value);
      saveMap();
    }
    return fresh;
  };
  // New pairs -> 'alias' events: the CRM moves a chat it already holds under the lid to the phone contact.
  const announce = async (fresh) => {
    if (!fresh.length || !ownPhone) return;
    for (let i = 0; i < fresh.length; i += HISTORY_BATCH) {
      await emit(fresh.slice(i, i + HISTORY_BATCH).map((p) => ({ kind: 'alias', numberPhone: ownPhone, lid: p.lid, phone: p.phone })));
    }
  };
  const learn = (payload) => {
    const r = readContacts(payload);
    r.names.forEach((v, k) => names.set(k, v));
    r.fresh = learnPairs([...r.lidPn].map(([lid, phone]) => ({ lid, phone })));
    return r;
  };

  const harvested = new Set();
  // Starts the download of the blob of a history-sync notification (our own copy: Baileys drops its lid -> phone table) and records the
  // promise: Baileys emits messaging-history.set BEFORE this finishes, and onHistory must know the phones before it sends chats.
  function harvestHistory(m) {
    const c = unwrap(m && m.message);
    const n = c && c.protocolMessage && c.protocolMessage.historySyncNotification;
    if (!n || typeof downloadHistory !== 'function' || !(n.directPath || n.url)) return null;
    const type = toNum(n.syncType);
    if (type === 1 || type === 4) return null;                   // INITIAL_STATUS_V3, PUSH_NAME: no chats
    const key = String(n.directPath || n.url) + ':' + type;
    if (harvested.has(key)) return null;
    harvested.add(key);
    const p = harvestBlob(n, type);
    pendingBlobs.add(p);
    p.finally(() => pendingBlobs.delete(p)).catch(() => {});
    return p;
  }
  async function harvestBlob(n, type) {
    try {
      const data = await downloadHistory(n, {});
      const r = readContacts({
        chats: (data.conversations || []).map((x) => ({ id: x.id, pnJid: x.pnJid, lidJid: x.lidJid })),
        contacts: (data.pushnames || []).map((x) => ({ id: x.id, notify: x.pushname })),
        mappings: data.phoneNumberToLidMappings
      });
      r.names.forEach((v, k) => { if (!names.has(k)) names.set(k, v); });
      const fresh = learnPairs([...r.lidPn].map(([lid, phone]) => ({ lid, phone })));
      info(`history blob: syncType ${type}, ${(data.conversations || []).length} chats, ${(data.phoneNumberToLidMappings || []).length} lid mappings, ${fresh.length} new, ${lidPn.size} known`);
      readOwn();
      await announce(fresh);
    } catch (e) { log.warn && log.warn('history blob failed: ' + short(e && e.message, 100)); }
  }
  const contactEvents = (r, skip) => {
    const out = [];
    r.names.forEach((name, waId) => { if (!skip.has(waId) && waId.length >= 5) out.push({ kind: 'contact', numberPhone: ownPhone, waId, profileName: name }); });
    return out;
  };

  async function onContacts(list) {
    readOwn();
    if (!ownPhone || !Array.isArray(list)) return;
    const found = learn({ contacts: list });
    await announce(found.fresh);
    const evs = contactEvents(found, new Set());
    for (let i = 0; i < evs.length; i += HISTORY_BATCH) await emit(evs.slice(i, i + HISTORY_BATCH));
  }

  // WhatsApp sends the old chats once, right after linking: a few messaging-history.set events (RECENT / FULL / PUSH_NAME).
  // The notification of a history chunk arrives in messages.upsert right AFTER Baileys emitted messaging-history.set for it. Wait one
  // tick (so onUpsert has started the blob download), then for every pending download (at most blobWaitMs).
  async function waitBlobs() {
    await new Promise((r) => setImmediate(r));
    if (!pendingBlobs.size) return;
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(r, blobWaitMs); });
    await Promise.race([Promise.allSettled([...pendingBlobs]), timeout]);
    clearTimeout(timer);
  }
  // End of a pairing sync (no more chunks for a while): every lid we ever sent to the CRM as a lid-only chat is announced once more
  // with its phone, so rows whose earlier alias batches were lost or came too late are merged now. Idempotent on the CRM side.
  function scheduleFinalPass() {
    clearTimeout(finalTimer);
    finalTimer = setTimeout(() => { finalPass().catch((e) => log.warn && log.warn('final alias pass failed: ' + short(e && e.message, 100))); }, finalPassMs);
    if (finalTimer.unref) finalTimer.unref();
  }
  async function finalPass() {
    readOwn();
    if (!ownPhone || stopped) return;
    const pairs = [];
    for (const lid of lids) { const phone = lidPn.get(lid); if (phone) pairs.push({ lid, phone }); }
    info(`final alias pass: ${pairs.length} of ${lids.size} lid chats have a known phone`);
    await announce(pairs);
  }

  async function onHistory(h) {
    await waitBlobs();
    if (stopped) return;
    readOwn();
    if (!ownPhone) return;
    const found = learn(h);
    await announce(found.fresh);
    // ON_DEMAND = the phone's answer to fetchMessageHistory (a page of ONE chat, no cap, no age limit: it was asked for)
    const onDemand = !!h.peerDataRequestSessionId || toNum(h.syncType) === SYNC_ON_DEMAND;
    const room = onDemand ? ON_DEMAND_PER_CHAT : HISTORY_CAP - historyCount;
    const events = [];
    if (room > 0) {
      const picked = selectHistory((h.messages || []).map(withPhone), { days: onDemand ? 36500 : HISTORY_DAYS, cap: room, perChat: HISTORY_PER_CHAT });
      for (const m of picked) {
        const mapped = mapMessage(m, { ownPhone, kind: 'history' });
        if (!mapped) continue;
        if (mapped.chat.lid) rememberLid(mapped.chat.waId);
        if (m.key.fromMe && sentIds.has(m.key.id)) continue;
        const ev = mapped.event;
        ev.profileName = names.get(ev.waId) || ev.profileName || '';
        events.push(ev);
      }
      if (!onDemand) historyCount += events.length;
    }
    const withMsgs = new Set(events.filter((e) => e.profileName).map((e) => e.waId));
    const all = events.concat(contactEvents(found, withMsgs));
    // Chats of the phone that came without messages (or beyond the cap): contact only. WhatsApp Web loads their messages on demand.
    let empty = 0;
    if (!onDemand) {
      const have = new Set(events.map((e) => e.waId));
      have.forEach((w) => chatsSent.add(w));
      const min = Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86400;
      for (const ce of mapChats(h.chats, ownPhone, lidPn)) {
        if (have.has(ce.waId) || chatsSent.has(ce.waId) || (ce.lastTs && ce.lastTs < min)) continue;
        if (emptyChats >= EMPTY_CHATS_CAP) break;
        ce.profileName = names.get(ce.waId) || ce.profileName;
        chatsSent.add(ce.waId); emptyChats++; empty++;
        all.push(ce);
      }
    }
    let answered = '';
    if (onDemand) {
      const sid = String(h.peerDataRequestSessionId || '');
      const key = historyReqs.has(sid) ? sid : (historyReqs.keys().next().value);   // an id we do not know: the oldest request is the one answered
      const rq = key === undefined ? null : historyReqs.get(key);
      if (rq) {
        historyReqs.delete(key);
        all.push({ kind: 'history_result', numberPhone: ownPhone, outboxId: rq.outboxId, chatJid: rq.chatJid, anchorTs: rq.anchorTs });
        answered = ` (request ${rq.outboxId} answered)`;
      }
    }
    info(`history: ${events.length} messages from ${new Set(events.map((e) => e.waId)).size} chats, ${empty} chats without messages, ${(h.contacts || []).length} contacts, syncType ${h.syncType}, progress ${h.progress}, total kept ${historyCount}/${HISTORY_CAP}${onDemand ? ', on demand' + answered : ''}`);
    for (let i = 0; i < all.length; i += HISTORY_BATCH) await emit(all.slice(i, i + HISTORY_BATCH));
    if (!onDemand) scheduleFinalPass();
  }

  /* ---------- outbox ---------- */
  // {seconds, waveform: Uint8Array(64)} from an outbox item, or null when the CRM did not send valid ones.
  const voiceWaveOf = (item) => {
    const w = parseWave(item && item.waveform), seconds = Math.round(Number(item && item.seconds));
    return w && seconds >= 1 && seconds <= 3600 ? { seconds, waveform: w } : null;
  };
  const jidFor = (to, item) => `${to}@${(item && item.lid === true) || lids.has(to) ? 'lid' : 's.whatsapp.net'}`;

  async function sendItem(item) {
    const id = item && Number(item.id);
    if (!id) return;
    if (doneOutbox.has(id)) { await crm.ack({ id, ok: true, extMsgId: doneOutbox.get(id) }).catch(() => {}); return; }
    if (item.type === 'history') return requestHistory(item, id);
    // A human-like pause before every message.
    await sleep(1000 + Math.floor(random() * 2000));
    let ack;
    try {
      const to = String(item.to || '').replace(/\D/g, '');
      if (to.length < 5 || to.length > 20) throw new Error('bad recipient');
      let content, wave = null;
      if (item.type === 'text') {
        if (!item.text) throw new Error('empty text');
        content = { text: String(item.text) };
      } else if (item.type === 'voice') {
        const media = await crm.getMedia(item.mediaRef);
        content = await prepareVoice(media.buffer, media.mime);
        wave = voiceWaveOf(item);
        if (wave && content.ptt) content.seconds = wave.seconds;
      } else if (item.type === 'image') {
        const media = await crm.getMedia(item.mediaRef);
        content = { image: media.buffer };
        if (item.text) content.caption = String(item.text);
        const mt = String(media.mime || '').split(';')[0].trim();
        if (/^image\//.test(mt)) content.mimetype = mt;
      } else throw new Error('unsupported type');
      if (state !== 'open' || !sock) throw new Error('not connected');
      // Baileys overwrites `waveform` of a voice note with its own (which needs an optional package we do not install) -> the hint
      // is applied by patchMessageBeforeSending in index.js right before the message is encrypted.
      voiceHint.current = wave && content.ptt ? wave : null;
      let res;
      try { res = await sock.sendMessage(jidFor(to, item), content); } finally { voiceHint.current = null; }
      const ext = res && res.key && res.key.id ? String(res.key.id) : '';
      if (ext) { sentIds.set(ext, Date.now()); trim(sentIds); }
      doneOutbox.set(id, ext); trim(doneOutbox);
      ack = { id, ok: true, extMsgId: ext };
    } catch (e) {
      ack = { id, ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    try { await crm.ack(ack); } catch (e) { log.warn && log.warn('ack failed: ' + e.message); }
  }

  // «Load older messages»: ask the phone for a page before the oldest message we hold, like WhatsApp Web. The answer is a separate
  // messaging-history.set (syncType ON_DEMAND) handled by onHistory; here only the request is sent and acknowledged.
  async function requestHistory(item, id) {
    let ack;
    try {
      const jid = String(item.chatJid || '');
      const o = item.oldest && typeof item.oldest === 'object' ? item.oldest : null;
      const tsMs = Math.round(Number(o && o.tsMs));
      const mid = o && o.id != null ? String(o.id) : '';
      if (!/^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(jid)) throw new Error('bad chat');
      // the anchor is the oldest message we hold; a chat without messages is asked "before its last message time" (best effort)
      if (!o || !(tsMs > 0) || (!mid && item.bestEffort !== true)) throw new Error('no anchor');
      if (state !== 'open' || !sock || typeof sock.fetchMessageHistory !== 'function') throw new Error('not connected');
      const count = Math.max(1, Math.min(50, Math.round(Number(item.count)) || 50));
      const reqId = await sock.fetchMessageHistory(count, { remoteJid: jid, fromMe: o.fromMe === true, id: mid }, tsMs);
      const rid = reqId ? String(reqId) : '';
      const at = now();
      for (const [k, v] of historyReqs) if (at - v.at > REQ_KEEP_MS) historyReqs.delete(k);
      historyReqs.set(rid || 'req' + id, { outboxId: id, chatJid: jid, anchorTs: Math.floor(tsMs / 1000), at });
      doneOutbox.set(id, rid); trim(doneOutbox);
      ack = { id, ok: true, extMsgId: rid };
    } catch (e) {
      ack = { id, ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    try { await crm.ack(ack); } catch (e) { log.warn && log.warn('ack failed: ' + e.message); }
  }

  let polling = false;
  async function pollOnce() {
    if (polling || stopped) return;
    polling = true;
    try {
      const ready = state === 'open' && !!sock;
      let res;
      try { res = await crm.outbox(ready); } catch (e) { return; }
      if (res && res.command === 'relink') {
        // The CRM repeats the command until it is acknowledged: a command already executed is only acknowledged again.
        if (res.commandId && res.commandId === lastCommandId) { await postState({ commandId: res.commandId }); return; }
        lastCommandId = res.commandId ? String(res.commandId) : '';
        await relink(lastCommandId);
        return;
      }
      if (!ready) return;
      for (const item of (res && res.items) || []) {
        if (state !== 'open') break;
        await sendItem(item);
      }
    } finally { polling = false; }
  }

  /* ---------- lifecycle ---------- */
  function start() {
    stopped = false;
    connect();
    postState();                       // tells the CRM at once which process is alive (its instance id)
    const loop = async () => { await pollOnce().catch(() => {}); if (!stopped) pollTimer = setTimeout(loop, 3000); };
    pollTimer = setTimeout(loop, 3000);
    beatTimer = setInterval(() => { if (state === 'open') markOnline(); postState(); queue.flush(); }, 60000);
    lastTick = now(); lastActivity = now();
    watchTimer = setInterval(() => { Promise.resolve(watchdogTick()).catch((e) => log.error && log.error('watchdog failed: ' + (e && e.message))); }, watchTickMs);
  }
  function stop() {
    stopped = true; gen++;
    clearTimeout(pollTimer); clearInterval(beatTimer); clearInterval(watchTimer); clearTimeout(finalTimer);
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
  }

  return { start, stop, connect, pollOnce, relink, heartbeat: postState, watchdogTick, forceReconnect, getState: () => ({ state, ownPhone, ownName }), _lids: lids, _sentIds: sentIds, chatIdOf };
}

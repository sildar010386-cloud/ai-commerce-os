// The connector core: owns the WhatsApp socket, turns its events into CRM events, executes the CRM outbox.
// All I/O is injected (socket factory, CRM client, queue, ffmpeg, clock), so it is testable with a fake socket.
import fs from 'node:fs';
import path from 'node:path';
import { mapMessage, mapUpdates, mapReceipts, selectHistory, readContacts, phoneOfJid, MAX_MEDIA_BYTES, chatIdOf } from './map.js';

// base64 of 64 bytes (0..100) -> Uint8Array, otherwise null
export function parseWave(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 64 || buf.some((x) => x > 100)) return null;
  return new Uint8Array(buf);
}

const LOGGED_OUT = 401, FORBIDDEN = 403, RESTART_REQUIRED = 515;
const NOTE_MEDIA_FAIL = 'не удалось загрузить файл — откройте на телефоне';
const HISTORY_BATCH = 15;
const HISTORY_CAP = 6000, HISTORY_DAYS = 365, HISTORY_PER_CHAT = 30;

export function createBridge({
  crm, queue, makeSocket, wipeAuth, renderQr, downloadMedia, prepareVoice, version, stateDir, voiceHint = { current: null },
  log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random,
  now = Date.now, watchdogMs = 5 * 60000, watchTickMs = 15000, sleepGapMs = 60000, stuckMs = 3 * 60000
}) {
  let gen = 0, sock = null, state = 'connecting', ownPhone = '', ownName = '';
  let reconnectN = 0, relinking = false, stopped = false, historyCount = 0, pollTimer = null, beatTimer = null, watchTimer = null;
  let lastActivity = now(), lastTick = now(), stateSince = now(), wsHooked = false;
  const sentIds = new Map();      // message ids we sent ourselves (their echo must not be reported as "sent from the phone")
  const doneOutbox = new Map();   // outbox id -> extMsgId, protects against double sending when an ack got lost
  const lids = new Set();
  const lidPn = new Map();        // anonymous @lid user -> real phone number (learned from history and contacts)
  const names = new Map();        // wa id -> name from the phone book / push names
  const lidFile = stateDir ? path.join(stateDir, 'lids.json') : '';
  try { if (lidFile && fs.existsSync(lidFile)) JSON.parse(fs.readFileSync(lidFile, 'utf8')).forEach((x) => lids.add(String(x))); } catch (e) { /* ignore */ }

  const rememberLid = (waId) => {
    if (lids.has(waId)) return;
    lids.add(waId);
    try { if (lidFile) fs.writeFileSync(lidFile, JSON.stringify([...lids].slice(-5000))); } catch (e) { /* ignore */ }
  };
  const trim = (map) => { while (map.size > 500) map.delete(map.keys().next().value); };
  const postState = async (extra) => {
    try { await crm.state(Object.assign({ state, version }, ownPhone && state === 'open' ? { phone: ownPhone, name: ownName } : {}, extra)); }
    catch (e) { log.warn && log.warn('state post failed: ' + e.message); }
  };
  const readOwn = () => {
    const u = sock && sock.user;
    if (u && u.id) { ownPhone = phoneOfJid(u.id); ownName = String(u.name || u.verifiedName || ''); }
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
    await sleep(delay);
    if (stopped || my !== gen) return;
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
    return connect();
  }

  async function onConnection(my, u) {
    if (u.qr) {
      state = 'qr';
      let png = '';
      try { png = await renderQr(u.qr); } catch (e) { log.error && log.error('qr render failed'); }
      if (png) await postState({ qr: png });
    }
    if (u.connection === 'connecting' && state !== 'qr') state = 'connecting';
    if (u.connection === 'open') {
      readOwn();
      state = 'open'; reconnectN = 0; historyCount = 0;
      await postState();
      queue.flush();
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect && u.lastDisconnect.error;
      const code = err && err.output && err.output.statusCode;
      if (relinking) return;
      if (code === LOGGED_OUT) return freshStart(my, 'logged_out');
      if (code === FORBIDDEN) { state = 'banned'; await postState({ reason: code }); return scheduleReconnect(my, 5 * 60000); }
      state = 'closed';
      await postState({ reason: code || 0 });
      return scheduleReconnect(my, code === RESTART_REQUIRED ? 500 : undefined);
    }
  }

  // The phone removed this linked device (or the number is gone): forget the session and show a new QR.
  async function freshStart(my, reason) {
    state = reason; ownPhone = ''; ownName = '';
    await postState();
    try { await wipeAuth(); } catch (e) { log.error && log.error('wipe auth failed: ' + e.message); }
    return scheduleReconnect(my, 1000);
  }

  async function relink() {
    if (relinking) return;
    relinking = true; gen++;
    try { if (sock && sock.logout) await Promise.race([sock.logout(), sleep(8000)]); } catch (e) { /* the phone may already be gone */ }
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
    try { await wipeAuth(); } catch (e) { log.error && log.error('wipe auth failed: ' + e.message); }
    state = 'logged_out'; ownPhone = ''; ownName = ''; reconnectN = 0;
    await postState();
    relinking = false;
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
    const live = u.type === 'notify';
    const min = Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86400;
    const events = [];
    for (const m0 of u.messages || []) {
      if (m0 && m0.key && m0.key.fromMe && sentIds.has(m0.key.id)) continue;
      const m = withPhone(m0);
      const mapped = mapMessage(m, { ownPhone, kind: live ? 'auto' : 'history' });
      if (!mapped) continue;
      if (mapped.chat.lid) rememberLid(mapped.chat.waId);
      if (!live && mapped.event.msg.ts < min) continue;
      events.push(live ? await withMedia(mapped, m) : mapped.event);
    }
    await emit(events);
  }

  // A @lid chat whose phone number we know is stored under the phone (so it is the same client as in the phone's chat list).
  const withPhone = (m) => {
    const key = m && m.key;
    if (!key || typeof key.remoteJid !== 'string' || !key.remoteJid.endsWith('@lid') || key.remoteJidAlt) return m;
    const pn = lidPn.get(key.remoteJid.split('@')[0].split(':')[0]);
    return pn ? Object.assign({}, m, { key: Object.assign({}, key, { remoteJidAlt: pn + '@s.whatsapp.net' }) }) : m;
  };
  const learn = (payload) => {
    const r = readContacts(payload);
    r.lidPn.forEach((v, k) => lidPn.set(k, v));
    r.names.forEach((v, k) => names.set(k, v));
    return r;
  };
  const contactEvents = (r, skip) => {
    const out = [];
    r.names.forEach((name, waId) => { if (!skip.has(waId) && waId.length >= 5) out.push({ kind: 'contact', numberPhone: ownPhone, waId, profileName: name }); });
    return out;
  };

  async function onContacts(list) {
    readOwn();
    if (!ownPhone || !Array.isArray(list)) return;
    const found = learn({ contacts: list });
    const evs = contactEvents(found, new Set());
    for (let i = 0; i < evs.length; i += HISTORY_BATCH) await emit(evs.slice(i, i + HISTORY_BATCH));
  }

  // WhatsApp sends the old chats once, right after linking: a few messaging-history.set events (RECENT / FULL / PUSH_NAME).
  async function onHistory(h) {
    readOwn();
    if (!ownPhone) return;
    const found = learn(h);
    const room = HISTORY_CAP - historyCount;
    const events = [];
    if (room > 0) {
      const picked = selectHistory((h.messages || []).map(withPhone), { days: HISTORY_DAYS, cap: room, perChat: HISTORY_PER_CHAT });
      for (const m of picked) {
        const mapped = mapMessage(m, { ownPhone, kind: 'history' });
        if (!mapped) continue;
        if (mapped.chat.lid) rememberLid(mapped.chat.waId);
        if (m.key.fromMe && sentIds.has(m.key.id)) continue;
        const ev = mapped.event;
        ev.profileName = names.get(ev.waId) || ev.profileName || '';
        events.push(ev);
      }
      historyCount += events.length;
    }
    const withMsgs = new Set(events.filter((e) => e.profileName).map((e) => e.waId));
    const all = events.concat(contactEvents(found, withMsgs));
    log.info && log.info(`history: ${events.length} messages from ${new Set(events.map((e) => e.waId)).size} chats, syncType ${h.syncType}, progress ${h.progress}`);
    for (let i = 0; i < all.length; i += HISTORY_BATCH) await emit(all.slice(i, i + HISTORY_BATCH));
  }

  /* ---------- outbox ---------- */
  // {seconds, waveform: Uint8Array(64)} from an outbox item, or null when the CRM did not send valid ones.
  const voiceWaveOf = (item) => {
    const w = parseWave(item && item.waveform), seconds = Math.round(Number(item && item.seconds));
    return w && seconds >= 1 && seconds <= 3600 ? { seconds, waveform: w } : null;
  };
  const jidFor = (to) => `${to}@${lids.has(to) ? 'lid' : 's.whatsapp.net'}`;

  async function sendItem(item) {
    const id = item && Number(item.id);
    if (!id) return;
    if (doneOutbox.has(id)) { await crm.ack({ id, ok: true, extMsgId: doneOutbox.get(id) }).catch(() => {}); return; }
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
      try { res = await sock.sendMessage(jidFor(to), content); } finally { voiceHint.current = null; }
      const ext = res && res.key && res.key.id ? String(res.key.id) : '';
      if (ext) { sentIds.set(ext, Date.now()); trim(sentIds); }
      doneOutbox.set(id, ext); trim(doneOutbox);
      ack = { id, ok: true, extMsgId: ext };
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
      if (res && res.command === 'relink') { await relink(); return; }
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
    const loop = async () => { await pollOnce().catch(() => {}); if (!stopped) pollTimer = setTimeout(loop, 3000); };
    pollTimer = setTimeout(loop, 3000);
    beatTimer = setInterval(() => { postState(); queue.flush(); }, 60000);
    lastTick = now(); lastActivity = now();
    watchTimer = setInterval(() => { Promise.resolve(watchdogTick()).catch((e) => log.error && log.error('watchdog failed: ' + (e && e.message))); }, watchTickMs);
  }
  function stop() {
    stopped = true; gen++;
    clearTimeout(pollTimer); clearInterval(beatTimer); clearInterval(watchTimer);
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
  }

  return { start, stop, connect, pollOnce, relink, heartbeat: postState, watchdogTick, forceReconnect, getState: () => ({ state, ownPhone, ownName }), _lids: lids, _sentIds: sentIds, chatIdOf };
}

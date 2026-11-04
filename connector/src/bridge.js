// The connector core: owns the WhatsApp socket, turns its events into CRM events, executes the CRM outbox.
// All I/O is injected (socket factory, CRM client, queue, ffmpeg, clock), so it is testable with a fake socket.
import fs from 'node:fs';
import path from 'node:path';
import { mapMessage, mapUpdates, mapReceipts, selectHistory, phoneOfJid, MAX_MEDIA_BYTES, chatIdOf } from './map.js';

const LOGGED_OUT = 401, FORBIDDEN = 403, RESTART_REQUIRED = 515;
const NOTE_MEDIA_FAIL = 'не удалось загрузить файл — откройте на телефоне';
const HISTORY_CAP = 5000, HISTORY_DAYS = 180;

export function createBridge({
  crm, queue, makeSocket, wipeAuth, renderQr, downloadMedia, convertVoice, version, stateDir,
  log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random
}) {
  let gen = 0, sock = null, state = 'connecting', ownPhone = '', ownName = '';
  let reconnectN = 0, relinking = false, stopped = false, historyCount = 0, pollTimer = null, beatTimer = null;
  const sentIds = new Map();      // message ids we sent ourselves (their echo must not be reported as "sent from the phone")
  const doneOutbox = new Map();   // outbox id -> extMsgId, protects against double sending when an ack got lost
  const lids = new Set();
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
    const guard = (fn) => (arg) => { if (my !== gen) return; Promise.resolve().then(() => fn(arg)).catch((e) => log.error && log.error('handler failed: ' + (e && e.message))); };
    s.ev.on('connection.update', guard((u) => onConnection(my, u)));
    s.ev.on('messages.upsert', guard(onUpsert));
    s.ev.on('messaging-history.set', guard(onHistory));
    s.ev.on('messages.update', guard((u) => emit(mapUpdates(u, ownPhone))));
    s.ev.on('message-receipt.update', guard((u) => emit(mapReceipts(u, ownPhone))));
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
    for (const m of u.messages || []) {
      if (m && m.key && m.key.fromMe && sentIds.has(m.key.id)) continue;
      const mapped = mapMessage(m, { ownPhone, kind: live ? 'auto' : 'history' });
      if (!mapped) continue;
      if (mapped.chat.lid) rememberLid(mapped.chat.waId);
      if (!live && mapped.event.msg.ts < min) continue;
      events.push(live ? await withMedia(mapped, m) : mapped.event);
    }
    await emit(events);
  }

  async function onHistory(h) {
    readOwn();
    if (!ownPhone) return;
    const room = HISTORY_CAP - historyCount;
    if (room <= 0) return;
    const picked = selectHistory(h.messages, { days: HISTORY_DAYS, cap: room });
    const events = [];
    for (const m of picked) {
      const mapped = mapMessage(m, { ownPhone, kind: 'history' });
      if (!mapped) continue;
      if (mapped.chat.lid) rememberLid(mapped.chat.waId);
      if (m.key.fromMe && sentIds.has(m.key.id)) continue;
      events.push(mapped.event);
    }
    historyCount += events.length;
    for (let i = 0; i < events.length; i += 100) await emit(events.slice(i, i + 100));
  }

  /* ---------- outbox ---------- */
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
      let content;
      if (item.type === 'text') {
        if (!item.text) throw new Error('empty text');
        content = { text: String(item.text) };
      } else if (item.type === 'voice') {
        const media = await crm.getMedia(item.mediaRef);
        content = { audio: await convertVoice(media.buffer), mimetype: 'audio/ogg; codecs=opus', ptt: true };
      } else if (item.type === 'image') {
        const media = await crm.getMedia(item.mediaRef);
        content = { image: media.buffer };
        if (item.text) content.caption = String(item.text);
        const mt = String(media.mime || '').split(';')[0].trim();
        if (/^image\//.test(mt)) content.mimetype = mt;
      } else throw new Error('unsupported type');
      if (state !== 'open' || !sock) throw new Error('not connected');
      const res = await sock.sendMessage(jidFor(to), content);
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
  }
  function stop() {
    stopped = true; gen++;
    clearTimeout(pollTimer); clearInterval(beatTimer);
    try { sock && sock.end && sock.end(undefined); } catch (e) { /* ignore */ }
  }

  return { start, stop, connect, pollOnce, relink, heartbeat: postState, getState: () => ({ state, ownPhone, ownName }), _lids: lids, _sentIds: sentIds, chatIdOf };
}

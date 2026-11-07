import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createEventQueue } from '../src/queue.js';
import { createCrm } from '../src/crm.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-test-'));
const tick = () => new Promise((r) => setImmediate(r));

function fakeSock() {
  const s = { ev: new EventEmitter(), user: { id: '77011112233:5@s.whatsapp.net', name: 'Bikas' }, sent: [], ended: false, loggedOut: false };
  s.sendMessage = async (jid, content) => { s.sent.push({ jid, content }); return { key: { id: 'SENT' + s.sent.length, fromMe: true, remoteJid: jid } }; };
  s.logout = async () => { s.loggedOut = true; };
  s.end = () => { s.ended = true; };
  return s;
}

function setup(over = {}) {
  const dir = tmp();
  const calls = { state: [], events: [], media: [], ack: [] };
  const sockets = [];
  let outbox = { items: [], command: null };
  const crm = {
    state: async (p) => { calls.state.push(p); },
    events: async (e) => { calls.events.push(...e); },
    uploadMedia: async (mime, buf) => { calls.media.push({ mime, len: buf.length }); return { id: 'm' + calls.media.length }; },
    getMedia: async (id) => ({ buffer: Buffer.from('AUDIO-' + id), mime: id.startsWith('img') ? 'image/png' : 'audio/webm' }),
    outbox: async (ready) => { calls.ready = ready; const o = outbox; outbox = { items: [], command: null }; return o; },
    ack: async (p) => { calls.ack.push(p); }
  };
  const queue = createEventQueue({ file: path.join(dir, 'q.jsonl'), send: (e) => crm.events(e), log: { warn() {} } });
  let wiped = 0;
  const bridge = createBridge(Object.assign({
    crm, queue, stateDir: dir, version: '1.2.3', log: { warn() {}, error() {} },
    makeSocket: async () => { const s = fakeSock(); sockets.push(s); return s; },
    wipeAuth: async () => { wiped++; },
    renderQr: async (q) => 'data:image/png;base64,QR(' + q + ')',
    downloadMedia: async () => Buffer.alloc(1000, 1),
    prepareVoice: async (b) => ({ audio: Buffer.concat([Buffer.from('OGG:'), b]), mimetype: 'audio/ogg; codecs=opus', ptt: true }),
    sleep: async () => {}, random: () => 0
  }, over));
  return { bridge, calls, sockets, queue, setOutbox: (o) => { outbox = o; }, wiped: () => wiped, dir };
}
const open = async (t) => { await t.bridge.connect(); t.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick(); await tick(); };

test('qr -> state qr with PNG data URL; open -> state open with own phone and name', async () => {
  const t = setup();
  await t.bridge.connect();
  const s = t.sockets[0];
  s.ev.emit('connection.update', { qr: 'QRSTRING' });
  await tick(); await tick();
  assert.equal(t.calls.state[0].state, 'qr');
  assert.equal(t.calls.state[0].qr, 'data:image/png;base64,QR(QRSTRING)');
  s.ev.emit('connection.update', { connection: 'open' });
  await tick(); await tick();
  const last = t.calls.state.at(-1);
  assert.deepEqual([last.state, last.phone, last.name, last.version], ['open', '77011112233', 'Bikas', '1.2.3']);
});

test('inbound text, voice with media upload, echo, group ignored', async () => {
  const t = setup();
  await open(t);
  const s = t.sockets[0];
  const k = (o) => Object.assign({ remoteJid: '77019998877@s.whatsapp.net', fromMe: false }, o);
  s.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: k({ id: 'A' }), message: { conversation: 'привет' }, messageTimestamp: 1760000000, pushName: 'Клиент' },
    { key: k({ id: 'B' }), message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', fileLength: 1000 } }, messageTimestamp: 1760000001 },
    { key: k({ id: 'C', fromMe: true }), message: { conversation: 'с телефона' }, messageTimestamp: 1760000002 },
    { key: k({ id: 'D', remoteJid: '1@g.us' }), message: { conversation: 'группа' }, messageTimestamp: 1760000003 }
  ] });
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(t.calls.events.map((e) => [e.kind, e.msg.id, e.msg.type]), [['message', 'A', 'text'], ['message', 'B', 'voice'], ['echo', 'C', 'text']]);
  assert.equal(t.calls.events[1].msg.mediaRef, 'm1');
  assert.deepEqual(t.calls.media, [{ mime: 'audio/ogg; codecs=opus', len: 1000 }]);
  assert.equal(t.calls.events[0].numberPhone, '77011112233');
});

test('big media is not downloaded; media failure falls back to a note', async () => {
  let downloads = 0;
  const t = setup({ downloadMedia: async () => { downloads++; throw new Error('boom'); } });
  await open(t);
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '77019998877@s.whatsapp.net', id: 'BIG' }, message: { imageMessage: { fileLength: 5e6 } }, messageTimestamp: 1760000000 },
    { key: { remoteJid: '77019998877@s.whatsapp.net', id: 'ERR' }, message: { imageMessage: { fileLength: 1000 } }, messageTimestamp: 1760000001 }
  ] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(downloads, 1);
  assert.match(t.calls.events[0].msg.body, /больше 1,5 МБ/);
  assert.match(t.calls.events[1].msg.body, /не удалось/);
  assert.equal(t.calls.events[1].msg.mediaRef, '');
});

const long = (n) => ({ low: n % 4294967296, high: Math.floor(n / 4294967296), unsigned: true });

test('history: old chats are imported in small batches, grouped by chat, with names; @lid resolved to the phone', async () => {
  const t = setup();
  await open(t);
  const now = Math.floor(Date.now() / 1000);
  const messages = [];
  for (let i = 0; i < 100; i++) messages.push({ key: { remoteJid: '77019998877@s.whatsapp.net', id: 'H' + i, fromMe: i % 2 === 0 }, message: { conversation: 'm' + i }, messageTimestamp: long(now - i * 60) });
  messages.push({ key: { remoteJid: '77019998877@s.whatsapp.net', id: 'OLD' }, message: { conversation: 'old' }, messageTimestamp: long(now - 800 * 86400) });
  messages.push({ key: { remoteJid: '55512345@lid', id: 'L1', fromMe: false }, message: { conversation: 'через lid' }, messageTimestamp: long(now - 5000), pushName: 'Мария' });
  messages.push({ key: { remoteJid: '99990001@lid', id: 'L2', fromMe: false }, message: { conversation: 'lid без номера' }, messageTimestamp: long(now - 6000) });
  t.sockets[0].ev.emit('messaging-history.set', {
    messages, syncType: 2, progress: 50,
    chats: [{ id: '77019998877@s.whatsapp.net', name: 'Клиент Алия' }],
    contacts: [{ id: '55512345@lid', lid: '55512345@lid', jid: '77015556677@s.whatsapp.net' }, { id: '77012223344@s.whatsapp.net', name: 'Без сообщений' }]
  });
  for (let i = 0; i < 12; i++) await tick();
  const hist = t.calls.events.filter((e) => e.kind === 'history');
  assert.equal(hist.length, 100 + 1 + 1, 'per-chat cap is 1000: all 100 recent messages of the long chat + the two lid chats (the 800-day-old one is dropped)');
  assert.equal(t.calls.events.at(-1).kind, 'contact');
  assert.deepEqual([t.calls.events.at(-1).waId, t.calls.events.at(-1).profileName], ['77012223344', 'Без сообщений']);
  const aliya = hist.filter((e) => e.waId === '77019998877');
  assert.equal(aliya.length, 100);
  assert.ok(aliya.every((e) => e.profileName === 'Клиент Алия'), 'chat name from history');
  assert.equal(aliya[0].msg.id, 'H99');
  assert.equal(aliya.at(-1).msg.id, 'H0');
  assert.ok(hist.find((e) => e.msg.id === 'L1').waId === '77015556677', 'lid mapped to the real phone');
  assert.ok(hist.find((e) => e.msg.id === 'L2').waId === '99990001', 'unknown lid stays addressable');
  assert.ok(t.calls.events.every((e) => e.numberPhone === '77011112233'));
});

test('history: sent to the CRM in requests of at most 15 events; a 4xx-rejected request does not block the rest', async () => {
  const sizes = [];
  let n = 0;
  const dir = tmp();
  const queue = createEventQueue({ file: path.join(dir, 'q.jsonl'), log: { warn() {} }, send: async (e) => {
    sizes.push(e.length);
    if (++n === 2) { const err = new Error('CRM answered 400'); err.status = 400; throw err; }
  } });
  const t = setup({ queue });
  await open(t);
  const now = Math.floor(Date.now() / 1000);
  const messages = [];
  for (let c = 0; c < 4; c++) for (let i = 0; i < 20; i++) messages.push({ key: { remoteJid: `7701000000${c}@s.whatsapp.net`, id: `C${c}M${i}` }, message: { conversation: 'x' }, messageTimestamp: now - i * 60 - c });
  t.sockets[0].ev.emit('messaging-history.set', { messages, chats: [], contacts: [] });
  for (let i = 0; i < 20; i++) await tick();
  assert.ok(sizes.every((x) => x <= 15), sizes.join());
  assert.equal(sizes.reduce((a, b) => a + b, 0), 80);
  assert.equal(queue.size(), 0, 'nothing left stuck in the queue');
});

test('history: same payload twice produces the same events (CRM ignores duplicates by message id)', async () => {
  const t = setup();
  await open(t);
  const now = Math.floor(Date.now() / 1000);
  const messages = [{ key: { remoteJid: '77019998877@s.whatsapp.net', id: 'D1' }, message: { conversation: 'a' }, messageTimestamp: now }];
  t.sockets[0].ev.emit('messaging-history.set', { messages, chats: [], contacts: [] });
  t.sockets[0].ev.emit('messaging-history.set', { messages, chats: [], contacts: [] });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(t.calls.events.map((e) => e.msg.id), ['D1', 'D1']);
});

test('voice from the CRM: duration goes into the message, the waveform is handed to patchMessageBeforeSending via voiceHint', async () => {
  const wave = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 10));
  const hint = { current: null };
  const seen = [];
  const t = setup({ voiceHint: hint, makeSocket: async () => {
    const s = fakeSock();
    s.sendMessage = async (jid, content) => { seen.push({ content, hint: hint.current }); return { key: { id: 'V1', fromMe: true, remoteJid: jid } }; };
    t.sockets.push(s); return s;
  } });
  await open(t);
  t.setOutbox({ items: [
    { id: 1, to: '77019998877', type: 'voice', mediaRef: 'aud1', seconds: 7, waveform: wave.toString('base64') },
    { id: 2, to: '77019998877', type: 'voice', mediaRef: 'aud2', seconds: 0, waveform: '' },
    { id: 3, to: '77019998877', type: 'voice', mediaRef: 'aud3', seconds: 5, waveform: 'garbage' }
  ] });
  await t.bridge.pollOnce();
  assert.equal(seen[0].content.seconds, 7);
  assert.deepEqual([...seen[0].hint.waveform], [...wave]);
  assert.equal(seen[0].hint.seconds, 7);
  assert.equal(seen[1].hint, null);
  assert.equal(seen[1].content.seconds, undefined);
  assert.equal(seen[2].hint, null, 'invalid waveform is ignored, the voice is still sent');
  assert.equal(hint.current, null, 'hint is cleared after sending');
  assert.deepEqual(t.calls.ack.map((a) => a.ok), [true, true, true]);
});

test('status events from messages.update', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('messages.update', [{ key: { remoteJid: '77019998877@s.whatsapp.net', fromMe: true, id: 'X1' }, update: { status: 4 } }]);
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(t.calls.events.map((e) => [e.kind, e.id, e.status]), [['status', 'X1', 'read']]);
});

test('outbox: text, voice (ffmpeg stub), image; acks; no duplicate send on repeated item', async () => {
  const t = setup();
  await open(t);
  t.setOutbox({ items: [
    { id: 1, to: '77019998877', type: 'text', text: 'Здравствуйте' },
    { id: 2, to: '77019998877', type: 'voice', mediaRef: 'aud1' },
    { id: 3, to: '77019998877', type: 'image', text: 'подпись', mediaRef: 'img1' }
  ], command: null });
  await t.bridge.pollOnce();
  const sent = t.sockets[0].sent;
  assert.equal(t.calls.ready, true);
  assert.equal(sent[0].jid, '77019998877@s.whatsapp.net');
  assert.deepEqual(sent[0].content, { text: 'Здравствуйте' });
  assert.equal(sent[1].content.ptt, true);
  assert.equal(sent[1].content.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(sent[1].content.audio.toString(), 'OGG:AUDIO-aud1');
  assert.equal(sent[2].content.caption, 'подпись');
  assert.equal(sent[2].content.mimetype, 'image/png');
  assert.deepEqual(t.calls.ack.map((a) => [a.id, a.ok, a.extMsgId]), [[1, true, 'SENT1'], [2, true, 'SENT2'], [3, true, 'SENT3']]);
  // the CRM requeued item 1 because an ack got lost: only re-ack
  t.setOutbox({ items: [{ id: 1, to: '77019998877', type: 'text', text: 'Здравствуйте' }], command: null });
  await t.bridge.pollOnce();
  assert.equal(sent.length, 3);
  assert.equal(t.calls.ack.at(-1).extMsgId, 'SENT1');
});

test('outbox: echo of our own send is not reported as "from phone"; bad items fail with ack', async () => {
  const t = setup();
  await open(t);
  t.setOutbox({ items: [{ id: 5, to: '77019998877', type: 'text', text: 'x' }, { id: 6, to: '12', type: 'text', text: 'y' }, { id: 7, to: '77019998877', type: 'sticker' }], command: null });
  await t.bridge.pollOnce();
  assert.deepEqual(t.calls.ack.map((a) => [a.id, a.ok]), [[5, true], [6, false], [7, false]]);
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '77019998877@s.whatsapp.net', fromMe: true, id: 'SENT1' }, message: { conversation: 'x' }, messageTimestamp: 1760000000 }] });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.calls.events.length, 0);
});

test('outbox: lid chats are addressed with @lid; nothing is sent while not connected', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '1234567890123@lid', id: 'L1' }, message: { conversation: 'hi' }, messageTimestamp: 1760000000 }] });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.calls.events[0].waId, '1234567890123');
  t.setOutbox({ items: [{ id: 9, to: '1234567890123', type: 'text', text: 'ответ' }], command: null });
  await t.bridge.pollOnce();
  assert.equal(t.sockets[0].sent[0].jid, '1234567890123@lid');

  const t2 = setup();
  await t2.bridge.connect();               // never opened
  t2.setOutbox({ items: [{ id: 1, to: '77019998877', type: 'text', text: 'x' }], command: null });
  await t2.bridge.pollOnce();
  assert.equal(t2.calls.ready, false);
  assert.equal(t2.sockets[0].sent.length, 0);
});

test('loggedOut close wipes auth, reports logged_out and starts a fresh socket', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.wiped(), 1);
  assert.ok(t.calls.state.some((s) => s.state === 'logged_out'));
  assert.equal(t.sockets.length, 2);
});

test('other close reasons reconnect without wiping auth', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.wiped(), 0);
  assert.equal(t.sockets.length, 2);
  assert.ok(t.sockets[0].ended);
});

test('relink command: logout, wipe auth, new socket, state logged_out', async () => {
  const t = setup();
  await open(t);
  t.setOutbox({ items: [{ id: 1, to: '77019998877', type: 'text', text: 'не должно уйти' }], command: 'relink' });
  await t.bridge.pollOnce();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.sockets[0].loggedOut, true);
  assert.equal(t.wiped(), 1);
  assert.equal(t.sockets.length, 2);
  assert.equal(t.sockets[0].sent.length, 0);
  assert.ok(t.calls.state.some((s) => s.state === 'logged_out'));
  // a stale event from the old socket is ignored
  t.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.wiped(), 1);
});

test('queue: events survive a CRM outage and are flushed in order', async () => {
  const dir = tmp();
  let up = false;
  const got = [];
  const q = createEventQueue({ file: path.join(dir, 'q.jsonl'), batch: 2, log: { warn() {} }, send: async (e) => { if (!up) throw new Error('down'); got.push(...e); } });
  await q.push([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await q.push([{ n: 4 }]);
  assert.equal(q.size(), 4);
  assert.equal(fs.readFileSync(path.join(dir, 'q.jsonl'), 'utf8').split('\n').filter(Boolean).length, 4);
  // a restart reloads the file
  const q2 = createEventQueue({ file: path.join(dir, 'q.jsonl'), batch: 2, log: { warn() {} }, send: async (e) => { if (!up) throw new Error('down'); got.push(...e); } });
  assert.equal(q2.size(), 4);
  up = true;
  await q2.flush();
  assert.deepEqual(got.map((e) => e.n), [1, 2, 3, 4]);
  assert.equal(q2.size(), 0);
  await q2.push([{ n: 5 }]);
  assert.deepEqual(got.map((e) => e.n).at(-1), 5);
});

test('crm client: bearer header, retries 5xx with backoff, no retry on 4xx', async () => {
  const seen = [];
  const sleeps = [];
  let n = 0;
  const fetchImpl = async (url, opt) => {
    seen.push([url, opt.headers.Authorization]);
    n++;
    if (n < 3) return { ok: false, status: 503, headers: new Headers() };
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Headers() };
  };
  const crm = createCrm({ url: 'https://crm.example/', token: 'TOK', fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await crm.events([{ a: 1 }]), { ok: true });
  assert.equal(seen[0][0], 'https://crm.example/api/connector/events');
  assert.equal(seen[0][1], 'Bearer TOK');
  assert.deepEqual(sleeps, [1000, 2000]);
  let calls = 0;
  const crm2 = createCrm({ url: 'https://crm.example', token: 'T', sleep: async () => {}, fetchImpl: async () => { calls++; return { ok: false, status: 401, headers: new Headers() }; } });
  await assert.rejects(() => crm2.events([]), (e) => e.status === 401);
  assert.equal(calls, 1);
});

function wdSetup(clockRef, extra = {}) {
  const sockets = [];
  const t = setup(Object.assign({
    now: () => clockRef.v, watchdogMs: 300000, sleepGapMs: 60000, stuckMs: 180000,
    makeSocket: async () => { const s = fakeSock(); s.ws = new EventEmitter(); sockets.push(s); return s; }
  }, extra));
  t.sockets = sockets;
  return t;
}

test('watchdog: waking up after a long sleep replaces the socket at once', async () => {
  const clock = { v: 1_000_000 };
  const t = wdSetup(clock);
  await open(t);
  clock.v += 15000; await t.bridge.watchdogTick();
  assert.equal(t.sockets.length, 1, 'a normal tick does nothing');
  clock.v += 2 * 3600 * 1000; await t.bridge.watchdogTick(); await tick();
  assert.equal(t.sockets.length, 2);
  assert.equal(t.sockets[0].ended, true);
});

test('watchdog: frames from WhatsApp keep the socket, silence for longer than the limit replaces it', async () => {
  const clock = { v: 5_000_000 };
  const t = wdSetup(clock);
  await open(t);
  for (let i = 0; i < 40; i++) { clock.v += 30000; t.sockets[0].ws.emit('message', Buffer.alloc(1)); await t.bridge.watchdogTick(); }
  assert.equal(t.sockets.length, 1, '20 minutes with frames every 30 s: fine');
  for (let i = 0; i < 6; i++) { clock.v += 59000; await t.bridge.watchdogTick(); }
  await tick();
  assert.equal(t.sockets.length, 2, 'more than 5 minutes of silence');
});

test('watchdog: a socket stuck in "connecting" is replaced; a quiet QR screen is not', async () => {
  const clock = { v: 9_000_000 };
  const t = wdSetup(clock);
  await t.bridge.connect();
  t.sockets[0].ev.emit('connection.update', { qr: 'Q' });
  await tick(); await tick();
  for (let i = 0; i < 20; i++) { clock.v += 30000; await t.bridge.watchdogTick(); }
  assert.equal(t.sockets.length, 1, 'waiting for the QR scan is normal');
  const t2 = wdSetup(clock);
  await t2.bridge.connect();                       // state stays "connecting"
  await t2.bridge.watchdogTick();                  // learns the state
  for (let i = 0; i < 8; i++) { clock.v += 30000; await t2.bridge.watchdogTick(); }
  assert.equal(t2.sockets.length, 2);
});

/* ---------- field report: connection logging, 440, relink on a dead socket ---------- */
const logSink = () => { const lines = []; return { lines, info: (m) => lines.push('I ' + m), warn: (m) => lines.push('W ' + m), error: (m) => lines.push('E ' + m) }; };
const closeWith = (s, code, message) => s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error(message || 'x'), { output: { statusCode: code } }) } });

test('every connection.update leaves one compact line: state, status code and reason, qr, open with the own number', async () => {
  const log = logSink();
  const t = setup({ log });
  await t.bridge.connect();
  const s = t.sockets[0];
  s.ev.emit('connection.update', { connection: 'connecting' });
  s.ev.emit('connection.update', { qr: 'QRSTRING' });
  s.ev.emit('connection.update', { connection: 'open' });
  for (let i = 0; i < 6; i++) await tick();
  closeWith(s, 408, 'Connection Lost');
  for (let i = 0; i < 6; i++) await tick();
  const text = log.lines.join('\n');
  assert.match(text, /conn: connection=connecting/);
  assert.match(text, /conn: qr=issued/);
  assert.match(text, /conn: open as \+77011112233/);
  assert.match(text, /conn: connection=close code=408 reason="Connection Lost"/);
  assert.match(text, /conn: reconnect in \d+ s/);
  assert.ok(!/QRSTRING/.test(text), 'the QR string itself is never logged');
});

test('history progress is logged as counters only', async () => {
  const log = logSink();
  const t = setup({ log });
  await open(t);
  t.sockets[0].ev.emit('messaging-history.set', { messages: [{ key: { id: 'H1', remoteJid: '77019998877@s.whatsapp.net', fromMe: false }, message: { conversation: 'SECRET-TEXT' }, messageTimestamp: Math.floor(Date.now() / 1000) - 60 }], contacts: [], syncType: 2, progress: 40 });
  for (let i = 0; i < 6; i++) await tick();
  const h = log.lines.find((l) => /history:/.test(l));
  assert.match(h, /history: 1 messages from 1 chats, 0 chats without messages, 0 contacts, syncType 2, progress 40, total kept 1\/14000/);
  assert.ok(!/SECRET-TEXT/.test(log.lines.join('')));
});

test('close code 440 (connection replaced): loud log, state replaced posted, 30 s back-off, no auth wipe', async () => {
  const log = logSink();
  const delays = [];
  const t = setup({ log, sleep: async (ms) => { delays.push(ms); } });
  await open(t);
  closeWith(t.sockets[0], 440, 'Stream Errored (conflict)');
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(log.lines.some((l) => l.startsWith('E ') && /REPLACED \(440\)/.test(l)));
  const st = t.calls.state.find((x) => x.state === 'replaced');
  assert.ok(st && st.reason === 440);
  assert.ok(delays.includes(30000), 'back-off 30 s: ' + delays);
  assert.equal(t.wiped(), 0);
  assert.equal(t.sockets.length, 2, 'it comes back after the wait');
});

test('relink when the socket is NOT open (closed, logout throws): still acknowledges, wipes auth and starts a socket that yields a QR', async () => {
  const log = logSink();
  const t = setup({ log });
  await open(t);
  const dead = t.sockets[0];
  dead.logout = async () => { throw new Error('Connection Closed'); };
  closeWith(dead, 408, 'Connection Lost');         // state is now "closed"
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(t.bridge.getState().state, 'closed');
  for (const x of t.sockets) x.logout = async () => { throw new Error('Connection Closed'); };
  t.setOutbox({ items: [], command: 'relink', commandId: 'c0ffee01' });
  await t.bridge.pollOnce();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.calls.ready, false, 'the poll happened with ready=0 and the command still arrived');
  assert.equal(t.wiped(), 1);
  const n = t.sockets.length;
  assert.ok(n >= 2);
  const states = t.calls.state.map((x) => x.state);
  assert.ok(states.indexOf('relinking') < states.indexOf('logged_out'), 'acknowledged first: ' + states);
  assert.equal(t.calls.state.find((x) => x.state === 'relinking').commandId, 'c0ffee01');
  // the fresh socket asks for a QR and the CRM gets it
  t.sockets.at(-1).ev.emit('connection.update', { qr: 'NEWQR' });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.calls.state.at(-1).state, 'qr');
  assert.match(t.calls.state.at(-1).qr, /NEWQR/);
  const text = log.lines.join('\n');
  assert.match(text, /relink: command received \(c0ffee01\), socket state was closed/);
  assert.match(text, /relink: logout failed \(Connection Closed\)/);
  assert.match(text, /relink: auth wiped/);
});

test('relink: a hanging logout does not block it; a repeated command id is only acknowledged again, not executed twice', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].logout = () => new Promise(() => {});          // never answers; sleep() (8 s race) is instant in tests
  t.setOutbox({ items: [], command: 'relink', commandId: 'id1' });
  await t.bridge.pollOnce();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.wiped(), 1);
  const before = t.calls.state.length;
  t.setOutbox({ items: [], command: 'relink', commandId: 'id1' });     // the CRM did not hear the first acknowledgement
  await t.bridge.pollOnce();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(t.wiped(), 1, 'not wiped again (it would destroy a QR the owner is scanning)');
  assert.ok(t.calls.state.slice(before).some((x) => x.commandId === 'id1'), 're-acknowledged');
  t.setOutbox({ items: [], command: 'relink', commandId: 'id2' });     // a new request
  await t.bridge.pollOnce();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.wiped(), 2);
});

test('legacy CRM (no command id): relink still works', async () => {
  const t = setup();
  await open(t);
  t.setOutbox({ items: [], command: 'relink' });
  await t.bridge.pollOnce();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.wiped(), 1);
  assert.ok(t.calls.state.some((x) => x.state === 'logged_out'));
});

test('start() reports the state at once (so the CRM learns the instance id) ', async () => {
  const t = setup();
  t.bridge.start();
  for (let i = 0; i < 4; i++) await tick();
  t.bridge.stop();
  assert.ok(t.calls.state.length >= 1);
});

/* ---------- @lid <-> phone ---------- */
const LIDA = '22664861229131', PHA = '77071110001';
const mk = (jid, id, extra) => Object.assign({ key: { remoteJid: jid, id, fromMe: false }, message: { conversation: 'text ' + id }, messageTimestamp: long(Math.floor(Date.now() / 1000) - 600) }, extra);

test('lid: history chat with pnJid goes to the CRM under the phone with the lid attached; an alias event comes first; the pair is persisted', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('messaging-history.set', {
    messages: [mk(LIDA + '@lid', 'A1'), mk('99990001999990@lid', 'A2')], syncType: 3, progress: 10,
    chats: [{ id: LIDA + '@lid', pnJid: PHA + '@s.whatsapp.net' }, { id: '99990001999990@lid' }], contacts: []
  });
  for (let i = 0; i < 12; i++) await tick();
  const ev = t.calls.events;
  assert.deepEqual(ev[0], { kind: 'alias', numberPhone: '77011112233', lid: LIDA, phone: PHA });
  const a1 = ev.find((e) => e.msg && e.msg.id === 'A1'), a2 = ev.find((e) => e.msg && e.msg.id === 'A2');
  assert.deepEqual([a1.waId, a1.lid], [PHA, LIDA]);
  assert.deepEqual([a2.waId, a2.lid], ['99990001999990', '99990001999990'], 'no phone known: waId = lid, and the event says so');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'lidmap.json'), 'utf8')), { [LIDA]: PHA });
  // same payload again: no new alias, same history events (the CRM merges them)
  const n = t.calls.events.filter((e) => e.kind === 'alias').length;
  t.sockets[0].ev.emit('messaging-history.set', { messages: [mk(LIDA + '@lid', 'A1')], syncType: 3, chats: [{ id: LIDA + '@lid', pnJid: PHA + '@s.whatsapp.net' }], contacts: [] });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.calls.events.filter((e) => e.kind === 'alias').length, n);
  // a restart of the connector: the map is loaded from disk, so a lid-only message is already stored under the phone
  const t2 = setup({ stateDir: t.dir });
  await open(t2);
  t2.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [mk(LIDA + '@lid', 'LIVE1')] });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual([t2.calls.events[0].waId, t2.calls.events[0].lid], [PHA, LIDA]);
});

test('lid: live message with sender_pn teaches the pair (alias event once); our own message never teaches it from senderPn', async () => {
  const t = setup();
  await open(t);
  const key = (o) => Object.assign({ remoteJid: LIDA + '@lid', fromMe: false }, o);
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: key({ id: 'M0', fromMe: true, senderPn: '77011112233@s.whatsapp.net' }), message: { conversation: 'с телефона' }, messageTimestamp: 1760000000 }] });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(t.calls.events.map((e) => [e.kind, e.waId]), [['echo', LIDA]], 'own number is not the customer number');
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: key({ id: 'M1', senderPn: PHA + '@s.whatsapp.net' }), message: { conversation: 'привет' }, messageTimestamp: 1760000001 }] });
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: key({ id: 'M2', senderPn: PHA + '@s.whatsapp.net' }), message: { conversation: 'ещё' }, messageTimestamp: 1760000002 }] });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.calls.events.filter((e) => e.kind === 'alias').length, 1);
  assert.deepEqual(t.calls.events.filter((e) => e.msg && e.msg.id !== 'M0').map((e) => [e.waId, e.lid]), [[PHA, LIDA], [PHA, LIDA]]);
});

test('lid: the history-sync blob is read for phoneNumberToLidMappings (which Baileys drops) when its notification arrives', async () => {
  const seen = [];
  const t = setup({ downloadHistory: async (n) => { seen.push(n.syncType); return {
    conversations: [{ id: '31111111111111@lid', pnJid: '77072220001@s.whatsapp.net' }],
    phoneNumberToLidMappings: [{ pnJid: '77072220002@s.whatsapp.net', lidJid: '32222222222222@lid' }],
    pushnames: [{ id: '77072220002@s.whatsapp.net', pushname: 'Берик' }]
  }; } });
  await open(t);
  const notif = (type) => ({ key: { remoteJid: '77011112233@s.whatsapp.net', fromMe: true, id: 'H' + type }, messageTimestamp: 1760000000,
    message: { protocolMessage: { historySyncNotification: { syncType: type, directPath: '/v/t62/hist' + type } } } });
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [notif(5), notif(5), notif(4), notif(1)] });
  for (let i = 0; i < 12; i++) await tick();
  assert.deepEqual(seen, [5], 'NON_BLOCKING_DATA is read once; PUSH_NAME / STATUS blobs and repeats are skipped');
  const al = t.calls.events.filter((e) => e.kind === 'alias').map((e) => [e.lid, e.phone]).sort();
  assert.deepEqual(al, [['31111111111111', '77072220001'], ['32222222222222', '77072220002']]);
  // a failing download is only logged
  const t2 = setup({ downloadHistory: async () => { throw new Error('boom'); } });
  await open(t2);
  t2.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [notif(3)] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t2.calls.events.length, 0);
});

test('lid: the outbox item flag and the known lid set decide the @lid address; a phone is never sent to @lid', async () => {
  const t = setup();
  await open(t);
  t.setOutbox({ items: [{ id: 1, to: '88888888888888', lid: true, type: 'text', text: 'a' }, { id: 2, to: PHA, type: 'text', text: 'b' }], command: null });
  await t.bridge.pollOnce();
  assert.deepEqual(t.sockets[0].sent.map((x) => x.jid), ['88888888888888@lid', PHA + '@s.whatsapp.net']);
});

test('lid: contacts.upsert with phoneNumber / jid fields and chats.phoneNumberShare teach pairs', async () => {
  const t = setup();
  await open(t);
  t.sockets[0].ev.emit('contacts.upsert', [{ id: '41111111111111@lid', phoneNumber: '+7 707 333 00 01', name: 'Алия' }]);
  t.sockets[0].ev.emit('chats.phoneNumberShare', { lid: '42222222222222@lid', jid: '77073330002@s.whatsapp.net' });
  for (let i = 0; i < 10; i++) await tick();
  const al = t.calls.events.filter((e) => e.kind === 'alias').map((e) => [e.lid, e.phone]).sort();
  assert.deepEqual(al, [['41111111111111', '77073330001'], ['42222222222222', '77073330002']]);
  assert.ok(t.calls.events.some((e) => e.kind === 'contact' && e.waId === '77073330001' && e.profileName === 'Алия'));
});

test('offline messages (upsert type append, newer than the last moment we were online) are NEW messages, not history', async () => {
  const T0 = Date.UTC(2026, 10, 5, 17, 0, 0);               // laptop switched off at 22:00 Almaty
  let clock = T0 + 12 * 3600e3;                             // switched on at 10:00 next morning
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'online.json'), JSON.stringify({ at: T0 }));
  const t = setup({ stateDir: dir, now: () => clock });
  await open(t);
  const k = (o) => Object.assign({ remoteJid: '77019998877@s.whatsapp.net', fromMe: false }, o);
  t.sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [
    { key: k({ id: 'NIGHT1', remoteJid: '77015550001@s.whatsapp.net' }), message: { conversation: 'Здравствуйте! Хочу заказать (A1)' }, messageTimestamp: Math.floor((T0 + 3 * 3600e3) / 1000), pushName: 'Айжан' },
    { key: k({ id: 'NIGHT2', remoteJid: '77015550002@s.whatsapp.net' }), message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', fileLength: 1000 } }, messageTimestamp: Math.floor((T0 + 5 * 3600e3) / 1000) },
    { key: k({ id: 'OLD1' }), message: { conversation: 'вчерашнее' }, messageTimestamp: Math.floor((T0 - 2 * 3600e3) / 1000) }
  ] });
  for (let i = 0; i < 6; i++) await tick();
  const by = Object.fromEntries(t.calls.events.map((e) => [e.msg.id, e]));
  assert.equal(by.NIGHT1.kind, 'message');                  // live: the CRM detects the source and counts it unread
  assert.equal(by.NIGHT2.kind, 'message');
  assert.equal(by.NIGHT2.msg.mediaRef, 'm1');               // the voice note is downloaded like a live one
  assert.equal(by.OLD1.kind, 'history');                    // older than the offline period: history as before
  // while open, the heartbeat moment moves forward; it is written to online.json
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'online.json'), 'utf8')).at >= clock);
  t.bridge.stop();
});

test('right after pairing (no online.json) appended messages stay history; relink forgets the online moment', async () => {
  const dir = tmp();
  const t = setup({ stateDir: dir, now: () => Date.UTC(2026, 10, 6, 5, 0, 0) });
  await open(t);
  t.sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [
    { key: { remoteJid: '77015550003@s.whatsapp.net', fromMe: false, id: 'P1' }, message: { conversation: 'старое из привязки' }, messageTimestamp: Math.floor(Date.UTC(2026, 10, 6, 4, 0, 0) / 1000) }
  ] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.calls.events.find((e) => e.msg.id === 'P1').kind, 'history');
  assert.ok(fs.existsSync(path.join(dir, 'online.json')));  // written on open
  await t.bridge.relink();
  assert.ok(!fs.existsSync(path.join(dir, 'online.json')));
  t.bridge.stop();
});

test('a message that could not be decrypted still reaches the CRM as a placeholder (new client is never lost); own phone and old stubs are not', async () => {
  const lines = [];
  const t = setup({ log: { info: (m) => lines.push(m), warn() {}, error() {} } });
  await open(t);
  t.sockets[0].user.lid = '122149071269903:5@lid';
  const nowS = Math.floor(Date.now() / 1000);
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '77015550010@s.whatsapp.net', fromMe: false, id: 'BAD1' }, messageStubType: 2, messageStubParameters: ['Key used already or never filled'], messageTimestamp: nowS - 60, pushName: 'Гульнар' },
    { key: { remoteJid: '26000000000001@lid', fromMe: false, id: 'BAD2' }, messageStubType: 2, messageStubParameters: ['No matching sessions found for message'], messageTimestamp: nowS - 30 },
    { key: { remoteJid: '122149071269903@lid', fromMe: false, id: 'OWN' }, messageStubType: 2, messageStubParameters: ['No matching sessions found for message'], messageTimestamp: nowS },
    { key: { remoteJid: '77011112233@s.whatsapp.net', fromMe: false, id: 'OWN2' }, messageStubType: 2, messageStubParameters: ['x'], messageTimestamp: nowS },
    { key: { remoteJid: '77015550011@s.whatsapp.net', fromMe: true, id: 'MINE' }, messageStubType: 2, messageStubParameters: ['x'], messageTimestamp: nowS },
    { key: { remoteJid: '77015550012@s.whatsapp.net', fromMe: false, id: 'ANCIENT' }, messageStubType: 2, messageStubParameters: ['x'], messageTimestamp: nowS - 20 * 86400 },
    { key: { remoteJid: '77015550013@s.whatsapp.net', fromMe: false, id: 'OK1' }, message: { conversation: 'Здравствуйте' }, messageTimestamp: nowS }
  ] });
  for (let i = 0; i < 8; i++) await tick();
  const ids = t.calls.events.map((e) => e.msg && e.msg.id);
  assert.deepEqual(ids.sort(), ['BAD1', 'BAD2', 'OK1']);
  const bad = t.calls.events.find((e) => e.msg.id === 'BAD1');
  assert.equal(bad.kind, 'message');
  assert.equal(bad.direction, 'in');
  assert.equal(bad.waId, '77015550010');
  assert.equal(bad.profileName, 'Гульнар');
  assert.equal(bad.msg.undecrypted, true);
  assert.match(bad.msg.body, /не расшифровалось/);
  assert.equal(t.calls.events.find((e) => e.msg.id === 'BAD2').lid, '26000000000001');
  // the log names every incoming message (last 4 digits only) and every failure
  assert.ok(lines.some((l) => l.includes('***0010 NOT DECRYPTED (Key used already or never filled)')));
  assert.ok(lines.some((l) => l === 'in: ***0013 text'));
  assert.ok(!lines.some((l) => l.includes('77015550013')));
  t.bridge.stop();
});

test('an offline stub (append) is a placeholder even right after pairing; live messages are queued one by one, before slow media', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup({ downloadMedia: async () => { await gate; return Buffer.alloc(10, 1); } });
  await open(t);
  const nowS = Math.floor(Date.now() / 1000);
  t.sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [
    { key: { remoteJid: '77015550020@s.whatsapp.net', fromMe: false, id: 'STUB' }, messageStubType: 2, messageStubParameters: ['Bad MAC'], messageTimestamp: nowS - 3600 }
  ] });
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '77015550021@s.whatsapp.net', fromMe: false, id: 'TXT' }, message: { conversation: 'Сколько стоит?' }, messageTimestamp: nowS }
  ] });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(t.calls.events.map((e) => e.msg.id).sort(), ['STUB', 'TXT']);
  assert.equal(t.calls.events.find((e) => e.msg.id === 'STUB').kind, 'message');
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '77015550022@s.whatsapp.net', fromMe: false, id: 'PHOTO' }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }, messageTimestamp: nowS },
  ] });
  t.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '77015550023@s.whatsapp.net', fromMe: false, id: 'TXT2' }, message: { conversation: 'Есть доставка?' }, messageTimestamp: nowS }
  ] });
  for (let i = 0; i < 8; i++) await tick();
  assert.ok(t.calls.events.some((e) => e.msg.id === 'TXT2'));   // not stuck behind the photo download
  assert.ok(!t.calls.events.some((e) => e.msg.id === 'PHOTO'));
  release();
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(t.calls.events.find((e) => e.msg.id === 'PHOTO').msg.mediaRef, 'm1');
  t.bridge.stop();
});

test('queue: a live message goes to the CRM before thousands of waiting history events; the drained backlog is logged', async () => {
  const dir = tmp();
  const sent = [];
  let gate = null;
  const lines = [];
  const q = createEventQueue({ file: path.join(dir, 'q.jsonl'), log: { info: (m) => lines.push(m), warn() {} }, send: async (evs) => { sent.push(evs.map((e) => e.kind + ':' + (e.msg ? e.msg.id : ''))); if (gate) await gate; } });
  const hist = [];
  for (let i = 0; i < 300; i++) hist.push({ kind: 'history', waId: '7701' + i, msg: { id: 'H' + i } });
  let open1;
  gate = new Promise((r) => { open1 = r; });
  const p1 = q.push(hist);                       // the first history request is in flight
  await tick();
  const p2 = q.push([{ kind: 'message', waId: '77015550099', msg: { id: 'LIVE' } }]);
  gate = null; open1();
  await p1; await p2; await q.flush();
  assert.deepEqual(sent[0].length, 15);          // the request already in flight
  assert.deepEqual(sent[1], ['message:LIVE']);   // then the live message, not 285 history events later
  assert.equal(sent.flat().length, 301);
  assert.equal(q.size(), 0);
  assert.ok(lines.some((l) => l === 'queue: all events delivered to the CRM (backlog was 301)'));
  // the file holds what is left, in order, after a restart
  const q2 = createEventQueue({ file: path.join(dir, 'q.jsonl'), send: async () => {}, log: { warn() {} } });
  assert.equal(q2.size(), 0);
});

// A socket whose events can be held back like Baileys' AwaitingInitialSync buffer.
function bufferingSock() {
  const s = fakeSock();
  const real = s.ev;
  let held = null;
  const ev = new EventEmitter();
  ev.on = (name, fn) => { real.on(name, fn); return ev; };
  ev.emit = (name, arg) => { if (held && name === 'messages.upsert') { held.push([name, arg]); return true; } return real.emit(name, arg); };
  ev.buffer = () => { held = held || []; };
  ev.flush = () => { const h = held || []; held = null; for (const [n, a] of h) real.emit(n, a); return h.length > 0; };
  s.ev = ev;
  return s;
}

test('a planned stop in the first seconds after a connect still delivers the buffered (offline) messages to the CRM', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'online.json'), JSON.stringify({ at: Date.now() - 8 * 3600e3 }));
  const sockets = [];
  const t = setup({ stateDir: dir, makeSocket: async () => { const s = bufferingSock(); sockets.push(s); return s; } });
  await t.bridge.connect();
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  for (let i = 0; i < 4; i++) await tick();
  sockets[0].ev.buffer();                                  // Baileys: AwaitingInitialSync
  const nowS = Math.floor(Date.now() / 1000);
  sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [
    { key: { remoteJid: '77015550031@s.whatsapp.net', fromMe: false, id: 'NIGHT31' }, message: { conversation: 'Здравствуйте' }, messageTimestamp: nowS - 3 * 3600 }
  ] });
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(!t.calls.events.some((e) => e.msg && e.msg.id === 'NIGHT31'));   // still held by the buffer
  await t.bridge.stop();                                    // the update stops the connector now
  const ev = t.calls.events.find((e) => e.msg && e.msg.id === 'NIGHT31');
  assert.ok(ev, 'the buffered message reached the CRM before the stop');
  assert.equal(ev.kind, 'message');
});

test('a message Baileys drops («Key used already») becomes a placeholder and the phone is asked to resend it; its real copy follows', async () => {
  const lines = [];
  const t = setup({ log: { info: (m) => lines.push(m), warn() {}, error() {} } });
  await open(t);
  const s = t.sockets[0];
  s.resend = [];
  s.requestPlaceholderResend = async (key) => { s.resend.push(key.id); };
  const err = new Error('Key used already or never filled');
  t.bridge.onDecryptError({ key: { remoteJid: '77015550040@s.whatsapp.net', fromMe: false, id: 'LOST1' }, err }, 'failed to decrypt message');
  t.bridge.onDecryptError({ key: { remoteJid: '77015550040@s.whatsapp.net', fromMe: false, id: 'LOST1' }, err }, 'failed to decrypt message');   // redelivered again
  t.bridge.onDecryptError({ key: { remoteJid: '77015550041@s.whatsapp.net', fromMe: true, id: 'MINE1' }, err }, 'failed to decrypt message');
  t.bridge.onDecryptError({ key: { remoteJid: '77015550042@s.whatsapp.net', fromMe: false, id: 'OTHER1' }, err: new Error('Bad MAC') }, 'failed to decrypt message');
  t.bridge.onDecryptError({ key: { remoteJid: '77015550043@s.whatsapp.net', id: 'X' } }, 'something else');
  for (let i = 0; i < 6; i++) await tick();
  const ph = t.calls.events.filter((e) => e.msg && e.msg.undecrypted);
  assert.deepEqual(ph.map((e) => e.msg.id), ['LOST1']);
  assert.equal(ph[0].waId, '77015550040');
  assert.equal(ph[0].kind, 'message');
  assert.deepEqual(s.resend, ['LOST1']);
  assert.ok(lines.some((l) => l.includes('***0040 NOT DECRYPTED') && l.includes('phone asked to resend')));
  // the phone answers: the same id arrives as a normal message
  s.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '77015550040@s.whatsapp.net', fromMe: false, id: 'LOST1' }, message: { conversation: 'Хочу заказать' }, messageTimestamp: Math.floor(Date.now() / 1000) - 3600 }] });
  for (let i = 0; i < 6; i++) await tick();
  const real = t.calls.events.find((e) => e.msg && e.msg.id === 'LOST1' && !e.msg.undecrypted);
  assert.equal(real.msg.body, 'Хочу заказать');
  t.bridge.stop();
});

test('the Baileys logger passes the original error object to the hook and survives a failing hook', async () => {
  const { makeBaileysLogger } = await import('../src/safelog.js');
  const out = [], seen = [];
  const lg = makeBaileysLogger((l) => out.push(l), 'warn', (o, m) => { seen.push([o.key && o.key.id, m]); throw new Error('hook bug'); });
  lg.child({}).error({ key: { id: 'K1' }, err: new Error('Key used already or never filled') }, 'failed to decrypt message');
  assert.deepEqual(seen, [['K1', 'failed to decrypt message']]);
  assert.ok(out[0].includes('Key used already') && !out[0].includes('K1'));   // the key never reaches the log
});

test('retries: a message we sent is kept and handed to Baileys (getMessage) when the client asks for it again, also after a restart', async () => {
  const { proto } = await import('@whiskeysockets/baileys');
  const encodeMessage = (m) => Buffer.from(proto.Message.encode(proto.Message.fromObject(m)).finish()).toString('base64');
  const decodeMessage = (b) => proto.Message.decode(Buffer.from(b, 'base64'));
  const dir = tmp();
  const made = [];
  const mk = async () => {
    const s = fakeSock(); made.push(s);
    s.sendMessage = async (jid, content) => ({
      key: { id: 'OUT' + (s.n = (s.n || 0) + 1), fromMe: true, remoteJid: jid },
      message: content.text ? proto.Message.fromObject({ extendedTextMessage: { text: content.text } })
        : proto.Message.fromObject({ imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.from([1, 2, 3]), url: 'https://mmg.whatsapp.net/x' } })
    });
    return s;
  };
  const lines = [];
  const t = setup({ stateDir: dir, makeSocket: mk, encodeMessage, decodeMessage, log: { info: (m) => lines.push(m), warn() {}, error() {} } });
  await t.bridge.connect(); made[0].ev.emit('connection.update', { connection: 'open' }); await tick(); await tick();
  t.setOutbox({ items: [{ id: 1, to: '77019998877', type: 'text', text: 'Здравствуйте, доставка 1-2 дня' }, { id: 2, to: '77019998877', type: 'image', mediaRef: 'img1' }], command: null });
  await t.bridge.pollOnce();
  const m1 = t.bridge.getSentMessage({ remoteJid: '77019998877@s.whatsapp.net', id: 'OUT1', fromMe: true });
  assert.equal(m1.extendedTextMessage.text, 'Здравствуйте, доставка 1-2 дня');
  const m2 = t.bridge.getSentMessage({ id: 'OUT2' });
  assert.deepEqual([...m2.imageMessage.mediaKey], [1, 2, 3]);
  assert.equal(t.bridge.getSentMessage({ id: 'NOPE' }), undefined);
  assert.ok(lines.some((l) => l.startsWith('retry: resending our message to ***8877')));
  t.bridge.stop();
  // a new process (restart / update) still has them
  const t2 = setup({ stateDir: dir, encodeMessage, decodeMessage });
  assert.equal(t2.bridge.getSentMessage({ id: 'OUT1' }).extendedTextMessage.text, 'Здравствуйте, доставка 1-2 дня');
});

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
    convertVoice: async (b) => Buffer.concat([Buffer.from('OGG:'), b]),
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

test('history: only last 180 days, batched, no media downloads', async () => {
  const t = setup();
  await open(t);
  const now = Math.floor(Date.now() / 1000);
  const messages = [];
  for (let i = 0; i < 230; i++) messages.push({ key: { remoteJid: '77019998877@s.whatsapp.net', id: 'H' + i, fromMe: i % 2 === 0 }, message: { conversation: 'm' + i }, messageTimestamp: now - i * 60 });
  messages.push({ key: { remoteJid: '77019998877@s.whatsapp.net', id: 'OLD' }, message: { conversation: 'old' }, messageTimestamp: now - 400 * 86400 });
  t.sockets[0].ev.emit('messaging-history.set', { messages, chats: [], contacts: [] });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.calls.events.length, 230);
  assert.ok(t.calls.events.every((e) => e.kind === 'history'));
  assert.equal(t.calls.events[0].msg.id, 'H229');   // oldest first
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

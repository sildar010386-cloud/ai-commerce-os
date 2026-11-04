// Older messages on demand (like WhatsApp Web), history ordering, final alias pass, chats without messages, CRM rejections logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createEventQueue } from '../src/queue.js';
import { createCrm } from '../src/crm.js';
import { mapMessage, mapChats, selectHistory, HISTORY_CAP, HISTORY_PER_CHAT } from '../src/map.js';

const tick = () => new Promise((r) => setImmediate(r));
const long = (n) => ({ low: n % 4294967296, high: Math.floor(n / 4294967296), unsigned: true });
const NOW = Math.floor(Date.now() / 1000);
const PH = '77011112233', P1 = '77071110001', L1 = '22664861229131';

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-od-'));
  const calls = { state: [], events: [], ack: [], logs: [] };
  const sockets = [];
  let outbox = { items: [], command: null };
  const crm = {
    state: async (p) => { calls.state.push(p); }, events: async (e) => { calls.events.push(...e); },
    uploadMedia: async () => ({ id: 'm' }), getMedia: async () => ({ buffer: Buffer.from('x'), mime: 'audio/webm' }),
    outbox: async () => { const o = outbox; outbox = { items: [], command: null }; return o; }, ack: async (p) => { calls.ack.push(p); }
  };
  const queue = createEventQueue({ file: path.join(dir, 'q.jsonl'), send: (e) => crm.events(e), log: { warn() {} } });
  const bridge = createBridge(Object.assign({
    crm, queue, stateDir: dir, version: 't', log: { info: (m) => calls.logs.push(m), warn() {}, error() {} },
    makeSocket: async () => {
      const s = { ev: new EventEmitter(), user: { id: PH + ':5@s.whatsapp.net', name: 'B' }, sent: [], fetches: [], end() {}, logout: async () => {} };
      s.fetchMessageHistory = async (count, key, tsMs) => { s.fetches.push({ count, key, tsMs }); return 'REQ' + s.fetches.length; };
      s.sendMessage = async () => ({ key: { id: 'S' } });
      sockets.push(s); return s;
    },
    wipeAuth: async () => {}, renderQr: async () => '', downloadMedia: async () => Buffer.alloc(1), prepareVoice: async (b) => ({ audio: b }),
    sleep: async () => {}, random: () => 0
  }, over));
  return { bridge, calls, sockets, queue, setOutbox: (o) => { outbox = o; }, dir };
}
const open = async (t) => { await t.bridge.connect(); t.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick(); await tick(); };
const settle = async () => { for (let i = 0; i < 25; i++) await tick(); };
const msg = (jid, id, fromMe, ago, text) => ({ key: { remoteJid: jid, id, fromMe }, message: { conversation: text }, messageTimestamp: long(NOW - ago) });

test('map: events carry the chat jid as WhatsApp addresses it (phone, lid, lid with a known phone)', () => {
  const ctx = { ownPhone: PH, kind: 'history' };
  assert.equal(mapMessage(msg(P1 + '@s.whatsapp.net', 'a', false, 5, 'x'), ctx).event.chatJid, P1 + '@s.whatsapp.net');
  assert.equal(mapMessage(msg(L1 + '@lid', 'b', false, 5, 'x'), ctx).event.chatJid, L1 + '@lid');
  const m = msg(L1 + '@lid', 'c', false, 5, 'x'); m.key.remoteJidAlt = P1 + '@s.whatsapp.net';
  const ev = mapMessage(m, ctx).event;
  assert.deepEqual([ev.waId, ev.lid, ev.chatJid], [P1, L1, L1 + '@lid'], 'stored under the phone, asked under the lid');
});

test('caps: 1000 per chat, 14000 per pairing', () => {
  assert.deepEqual([HISTORY_PER_CHAT, HISTORY_CAP], [1000, 14000]);
  const msgs = [];
  for (let c = 0; c < 25; c++) for (let i = 0; i < 1100; i++) msgs.push(msg('7700000' + String(1000 + c) + '@s.whatsapp.net', `c${c}m${i}`, false, i + 1, 't'));
  const out = selectHistory(msgs, { now: Date.now() });
  assert.equal(out.length, 14000);
  const per = new Map();
  for (const m of out) per.set(m.key.remoteJid, (per.get(m.key.remoteJid) || 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 1000));
});

test('mapChats: chats without messages become chat events with the phone from the lid mapping and the conversation time', () => {
  const lidPn = new Map([['111111111', P1]]);
  const out = mapChats([
    { id: '111111111@lid', name: 'Алия', conversationTimestamp: long(NOW - 100) },
    { id: P1 + '@s.whatsapp.net', lidJid: L1 + '@lid', lastMsgTimestamp: NOW - 50 },
    { id: '1203@g.us', name: 'group', conversationTimestamp: NOW },
    { id: '22248484286584@lid' }                                    // nothing known: skipped
  ], PH, lidPn);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].waId, out[0].lid, out[0].chatJid, out[0].profileName, out[0].lastTs], [P1, '111111111', '111111111@lid', 'Алия', NOW - 100]);
  assert.deepEqual([out[1].waId, out[1].lid, out[1].chatJid, out[1].lastTs], [P1, L1, P1 + '@s.whatsapp.net', NOW - 50]);
});

test('outbox type history: fetchMessageHistory gets (count, {remoteJid, fromMe, id}, tsMs) and the item is acknowledged ok', async () => {
  const t = setup(); await open(t);
  const item = { id: 7, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: 'OLDEST', fromMe: true, tsMs: 1760000000000 }, count: 50 };
  t.setOutbox({ items: [item], command: null });
  await t.bridge.pollOnce();
  assert.deepEqual(t.sockets[0].fetches, [{ count: 50, key: { remoteJid: P1 + '@s.whatsapp.net', fromMe: true, id: 'OLDEST' }, tsMs: 1760000000000 }]);
  assert.deepEqual(t.calls.ack, [{ id: 7, ok: true, extMsgId: 'REQ1' }]);
  assert.equal(t.sockets[0].sent.length, 0);
  // the same item handed out again (a lost ack) is not requested twice
  t.setOutbox({ items: [item], command: null });
  await t.bridge.pollOnce();
  assert.equal(t.sockets[0].fetches.length, 1);
});

test('outbox type history: no anchor / bad chat / not connected are acknowledged with an error and nothing is requested', async () => {
  const t = setup(); await open(t);
  t.setOutbox({ items: [
    { id: 1, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: null, count: 50 },
    { id: 2, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: '', fromMe: false, tsMs: 1760000000000 }, count: 50 },
    { id: 3, to: P1, type: 'history', chatJid: 'junk@g.us', oldest: { id: 'X', fromMe: false, tsMs: 1760000000000 }, count: 50 },
    { id: 4, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: 'X', fromMe: false, tsMs: 0 }, count: 50 }
  ], command: null });
  await t.bridge.pollOnce();
  assert.deepEqual(t.calls.ack.map((a) => [a.id, a.ok, a.error]), [[1, false, 'no anchor'], [2, false, 'no anchor'], [3, false, 'bad chat'], [4, false, 'no anchor']]);
  assert.equal(t.sockets[0].fetches.length, 0);
});

test('outbox type history: a chat without messages is asked best-effort with an empty id and the given time', async () => {
  const t = setup(); await open(t);
  t.setOutbox({ items: [{ id: 5, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: '', fromMe: false, tsMs: 1760000001000 }, bestEffort: true, count: 50 }], command: null });
  await t.bridge.pollOnce();
  assert.deepEqual(t.sockets[0].fetches, [{ count: 50, key: { remoteJid: P1 + '@s.whatsapp.net', fromMe: false, id: '' }, tsMs: 1760000001000 }]);
  assert.equal(t.calls.ack[0].ok, true);
});

test('ON_DEMAND messaging-history.set: ingested as kind history without the age limit, not counted against the pairing cap, followed by history_result', async () => {
  const t = setup(); await open(t);
  t.setOutbox({ items: [{ id: 9, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: 'OLDEST', fromMe: false, tsMs: (NOW - 900 * 86400) * 1000 }, count: 50 }], command: null });
  await t.bridge.pollOnce();
  const old = [];
  for (let i = 0; i < 50; i++) old.push(msg(P1 + '@s.whatsapp.net', 'O' + i, i % 2 === 0, 1000 * 86400 - i * 60, 'old ' + i));   // ~1000 days old
  t.sockets[0].ev.emit('messaging-history.set', { chats: [], contacts: [], messages: old, syncType: 6, peerDataRequestSessionId: 'REQ1' });
  await settle();
  const hist = t.calls.events.filter((e) => e.kind === 'history');
  assert.equal(hist.length, 50, 'older than 365 days is kept: it was asked for');
  assert.ok(hist.every((e) => e.chatJid === P1 + '@s.whatsapp.net' && e.waId === P1));
  const last = t.calls.events.at(-1);
  assert.deepEqual([last.kind, last.outboxId, last.anchorTs, last.chatJid], ['history_result', 9, NOW - 900 * 86400, P1 + '@s.whatsapp.net']);
  assert.ok(t.calls.logs.some((l) => /syncType 6.*total kept 0\/14000.*on demand \(request 9 answered\)/.test(l)), t.calls.logs.join('\n'));
  // an answer with no messages still reports the result (the CRM then marks the chat done)
  t.setOutbox({ items: [{ id: 10, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: 'O49', fromMe: false, tsMs: 1000 * 1000 }, count: 50 }], command: null });
  await t.bridge.pollOnce();
  t.calls.events.length = 0;
  t.sockets[0].ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], syncType: 6, peerDataRequestSessionId: 'REQ2' });
  await settle();
  assert.deepEqual(t.calls.events.map((e) => [e.kind, e.outboxId, e.anchorTs]), [['history_result', 10, 1000]]);
});

test('ON_DEMAND answers keep coming after the pairing cap is reached; an unknown session id answers the oldest request', async () => {
  const t = setup(); await open(t);
  const big = [];
  for (let c = 0; c < 21; c++) for (let i = 0; i < 1000; i++) big.push(msg('7700000' + String(1000 + c) + '@s.whatsapp.net', `c${c}m${i}`, false, i + 1, 't'));
  t.sockets[0].ev.emit('messaging-history.set', { chats: [], contacts: [], messages: big, syncType: 3, progress: 50 });
  await settle(); await settle();
  assert.equal(t.calls.events.filter((e) => e.kind === 'history').length, 14000, 'pairing cap');
  t.setOutbox({ items: [{ id: 3, to: P1, type: 'history', chatJid: P1 + '@s.whatsapp.net', oldest: { id: 'Z', fromMe: false, tsMs: 5000 }, count: 50 }], command: null });
  await t.bridge.pollOnce();
  t.calls.events.length = 0;
  t.sockets[0].ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg(P1 + '@s.whatsapp.net', 'ODD', false, 4000 * 86400, 'older')], syncType: 6, peerDataRequestSessionId: 'something-else' });
  await settle();
  assert.deepEqual(t.calls.events.map((e) => e.kind), ['history', 'history_result']);
  assert.equal(t.calls.events[1].outboxId, 3);
});

test('ORDER: messaging-history.set arrives before the blob download finishes: the phones are known before any chat is sent', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup({
    downloadHistory: async () => { await gate; return { conversations: [{ id: L1 + '@lid', pnJid: P1 + '@s.whatsapp.net' }], phoneNumberToLidMappings: [{ pnJid: P1 + '@s.whatsapp.net', lidJid: L1 + '@lid' }], pushnames: [] }; }
  });
  await open(t);
  const s = t.sockets[0];
  // Baileys: history.set first, the notification message (messages.upsert) right after it
  s.ev.emit('messaging-history.set', { chats: [{ id: L1 + '@lid', name: 'Алия', conversationTimestamp: NOW - 50 }], contacts: [], messages: [msg(L1 + '@lid', 'L1', false, 60, 'привет')], syncType: 3, progress: 9 });
  s.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: PH + '@s.whatsapp.net', fromMe: true, id: 'N1' }, messageTimestamp: NOW,
    message: { protocolMessage: { historySyncNotification: { syncType: 3, directPath: '/v/t62/blob1' } } } }] });
  for (let i = 0; i < 15; i++) await tick();
  assert.equal(t.calls.events.filter((e) => e.kind === 'history').length, 0, 'nothing is sent while the blob is still downloading');
  release();
  await settle();
  const h = t.calls.events.filter((e) => e.kind === 'history');
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].waId, h[0].lid, h[0].chatJid], [P1, L1, L1 + '@lid'], 'sent under the phone, not as a lid-only chat');
  assert.ok(t.calls.events.some((e) => e.kind === 'alias' && e.lid === L1 && e.phone === P1));
});

test('ORDER: a blob that never finishes does not block the history for longer than blobWaitMs', async () => {
  const t = setup({ blobWaitMs: 30, downloadHistory: () => new Promise(() => {}) });
  await open(t);
  const s = t.sockets[0];
  s.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg(L1 + '@lid', 'L1', false, 60, 'привет')], syncType: 3, progress: 9 });
  s.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: PH + '@s.whatsapp.net', fromMe: true, id: 'N1' }, messageTimestamp: NOW,
    message: { protocolMessage: { historySyncNotification: { syncType: 3, directPath: '/v/t62/blob2' } } } }] });
  await new Promise((r) => setTimeout(r, 120));
  await settle();
  const h = t.calls.events.filter((e) => e.kind === 'history');
  assert.deepEqual([h.length, h[0].waId], [1, L1]);
});

test('chats without messages are sent as chat events (name, lid mapping, conversation time), once, capped, and never for chats that have messages', async () => {
  const t = setup(); await open(t);
  const chats = [{ id: P1 + '@s.whatsapp.net', name: 'С сообщениями', conversationTimestamp: NOW - 10 }, { id: '77071110002@s.whatsapp.net', name: 'Пустой', conversationTimestamp: long(NOW - 3600) },
    { id: '77071110003@s.whatsapp.net', conversationTimestamp: NOW - 400 * 86400 }];
  t.sockets[0].ev.emit('messaging-history.set', { chats, contacts: [], messages: [msg(P1 + '@s.whatsapp.net', 'M1', false, 10, 'hi')], syncType: 3, progress: 20 });
  await settle();
  const ce = t.calls.events.filter((e) => e.kind === 'chat');
  assert.deepEqual(ce.map((e) => [e.waId, e.profileName, e.lastTs, e.chatJid]), [['77071110002', 'Пустой', NOW - 3600, '77071110002@s.whatsapp.net']], 'older than a year and chats with messages are skipped');
  t.calls.events.length = 0;
  t.sockets[0].ev.emit('messaging-history.set', { chats, contacts: [], messages: [], syncType: 3, progress: 30 });
  await settle();
  assert.equal(t.calls.events.filter((e) => e.kind === 'chat').length, 0, 'announced once');
  assert.ok(t.calls.logs.some((l) => /1 chats without messages/.test(l)));
});

test('final alias pass: every lid sent as a lid-only chat is announced again with its phone after the sync ends', async () => {
  const t = setup({ finalPassMs: 40 }); await open(t);
  const s = t.sockets[0];
  s.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg(L1 + '@lid', 'L1', false, 60, 'привет')], syncType: 3, progress: 50 });   // phone still unknown
  await settle();
  assert.equal(t.calls.events.filter((e) => e.kind === 'alias').length, 0);
  s.ev.emit('contacts.upsert', [{ id: L1 + '@lid', lid: L1 + '@lid', jid: P1 + '@s.whatsapp.net' }]);    // learned later
  await settle();
  const first = t.calls.events.filter((e) => e.kind === 'alias').length;
  assert.equal(first, 1);
  t.calls.events.length = 0;
  await new Promise((r) => setTimeout(r, 120));
  await settle();
  assert.deepEqual(t.calls.events.map((e) => [e.kind, e.lid, e.phone]), [['alias', L1, P1]], 'one more pass for the lid that was sent as a lid-only chat');
  assert.ok(t.calls.logs.some((l) => /final alias pass: 1 of 1/.test(l)));
});

test('queue: every CRM rejection is logged with status and the start of the answer, a permanent one drops the batch, lastError is kept until a success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-q-'));
  const warns = [];
  let mode = 'bad';
  const send = async (events) => {
    if (mode === 'bad') { const e = new Error('CRM answered 400'); e.status = 400; e.body = '{"error":"Некорректный запрос"}'; throw e; }
    if (mode === 'down') { const e = new Error('CRM answered 500'); e.status = 500; e.body = 'oops'; throw e; }
  };
  const q = createEventQueue({ file: path.join(dir, 'q.jsonl'), send, log: { warn: (m) => warns.push(m) } });
  await q.push([{ kind: 'alias', numberPhone: PH, lid: L1, phone: P1 }]);
  assert.equal(q.size(), 0, 'dropped');
  assert.match(warns[0], /dropping 1 events the CRM rejected \(alias x1\): 400 \{"error":"Некорректный запрос"\}/);
  assert.match(q.lastError(), /^dropped \[alias x1\] 400 /);
  mode = 'down';
  await q.push([{ kind: 'history', numberPhone: PH }]);
  assert.equal(q.size(), 1, 'kept for a retry');
  assert.match(warns.at(-1), /CRM did not accept 1 events \(history x1\), will retry: 500 oops/);
  assert.match(q.lastError(), /^retry /);
  mode = 'ok';
  await q.flush();
  assert.equal(q.lastError(), '');
});

test('crm client: an error answer keeps its first 200 characters in err.body', async () => {
  const crm = createCrm({ url: 'http://x', token: 't', retries: 0, sleep: async () => {}, fetchImpl: async () => new Response('Z'.repeat(500), { status: 400 }) });
  await assert.rejects(() => crm.events([{}]), (e) => e.status === 400 && e.body === 'Z'.repeat(200));
});

test('state posts carry the last CRM rejection', async () => {
  const t = setup();
  t.queue.lastError = () => 'dropped [alias x6] 400 boom';
  await open(t);
  assert.equal(t.calls.state.at(-1).lastError, 'dropped [alias x6] 400 boom');
});

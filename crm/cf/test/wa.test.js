// Unit tests for src/wa.js. Run: node --test test/*.test.js   (Node 20+, no dependencies)
// CommonJS wrapper + dynamic import(): src/ is an ES module (src/package.json), test/ stays CommonJS like kazpost.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let parseWebhook, parseMessage, normalizeInboxEvents;
before(async () => {
  ({ parseWebhook, parseMessage, normalizeInboxEvents } = await import(pathToFileURL(path.join(__dirname, '../src/wa.js')).href));
});

const META = { display_phone_number: '7 701 111 22 33', phone_number_id: '1000000000001' };
const wrap = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value }] }] });
const inbound = (messages, extra) => wrap('messages', Object.assign({
  messaging_product: 'whatsapp', metadata: META, contacts: [{ profile: { name: 'Айгерим' }, wa_id: '77011234567' }], messages
}, extra));

test('text message with contact name', () => {
  const ev = parseWebhook(inbound([{ from: '77011234567', id: 'wamid.A', timestamp: '1760000000', type: 'text', text: { body: 'Привет (A3)' } }]));
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.kind, 'message');
  assert.equal(e.direction, 'in');
  assert.equal(e.phoneNumberId, '1000000000001');
  assert.equal(e.displayPhone, '77011112233');
  assert.equal(e.waId, '77011234567');
  assert.equal(e.profileName, 'Айгерим');
  assert.equal(e.msg.id, 'wamid.A');
  assert.equal(e.msg.type, 'text');
  assert.equal(e.msg.body, 'Привет (A3)');
  assert.equal(e.msg.ts, new Date(1760000000 * 1000).toISOString());
});

test('click-to-WhatsApp referral is kept', () => {
  const ref = { source_url: 'https://fb.me/x', source_type: 'ad', source_id: '123', headline: 'H', body: 'B' };
  const ev = parseWebhook(inbound([{ from: '77011234567', id: 'w1', timestamp: '1760000000', type: 'text', text: { body: 'hi' }, referral: ref }]));
  assert.deepEqual(ev[0].msg.referral, ref);
});

test('voice vs plain audio', () => {
  const ev = parseWebhook(inbound([
    { from: '77011234567', id: 'w2', timestamp: '1', type: 'audio', audio: { id: 'M1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { from: '77011234567', id: 'w3', timestamp: '1', type: 'audio', audio: { id: 'M2', mime_type: 'audio/mpeg' } }
  ]));
  assert.equal(ev[0].msg.type, 'voice');
  assert.equal(ev[0].msg.voice, true);
  assert.equal(ev[0].msg.mediaId, 'M1');
  assert.equal(ev[1].msg.type, 'audio');
  assert.equal(ev[1].msg.voice, false);
});

test('image, video, document, sticker', () => {
  const ev = parseWebhook(inbound([
    { from: '77011234567', id: 'i', timestamp: '1', type: 'image', image: { id: 'I1', mime_type: 'image/jpeg', caption: 'вот' } },
    { from: '77011234567', id: 'v', timestamp: '1', type: 'video', video: { id: 'V1', mime_type: 'video/mp4' } },
    { from: '77011234567', id: 'd', timestamp: '1', type: 'document', document: { id: 'D1', mime_type: 'application/pdf', filename: 'check.pdf' } },
    { from: '77011234567', id: 's', timestamp: '1', type: 'sticker', sticker: { id: 'S1', mime_type: 'image/webp' } }
  ]));
  assert.deepEqual(ev.map((e) => e.msg.type), ['image', 'video', 'document', 'sticker']);
  assert.equal(ev[0].msg.caption, 'вот');
  assert.equal(ev[0].msg.mime, 'image/jpeg');
  assert.equal(ev[2].msg.caption, 'check.pdf');
  assert.equal(ev[3].msg.mediaId, 'S1');
});

test('location, button, interactive, reaction, unknown', () => {
  const ev = parseWebhook(inbound([
    { from: '77011234567', id: 'l', timestamp: '1', type: 'location', location: { latitude: 43.2, longitude: 76.9, name: 'Дом' } },
    { from: '77011234567', id: 'b', timestamp: '1', type: 'button', button: { text: 'Да', payload: 'yes' } },
    { from: '77011234567', id: 'ib', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '1', title: 'Заказать' } } },
    { from: '77011234567', id: 'il', timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: '2', title: 'Доставка' } } },
    { from: '77011234567', id: 'r', timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } },
    { from: '77011234567', id: 'u', timestamp: '1', type: 'unsupported', errors: [{ code: 131051 }] }
  ]));
  assert.equal(ev[0].msg.type, 'location');
  assert.match(ev[0].msg.body, /43\.2,76\.9/);
  assert.equal(ev[1].msg.body, 'Да');
  assert.equal(ev[2].msg.body, 'Заказать');
  assert.equal(ev[3].msg.body, 'Доставка');
  assert.equal(ev[4].msg.type, 'reaction');
  assert.equal(ev[4].msg.body, '👍');
  assert.equal(ev[5].msg.type, 'other');
});

test('statuses', () => {
  const ev = parseWebhook(wrap('messages', {
    messaging_product: 'whatsapp', metadata: META,
    statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1760000100', recipient_id: '77011234567' }]
  }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'status');
  assert.equal(ev[0].id, 'wamid.OUT');
  assert.equal(ev[0].status, 'delivered');
  assert.equal(ev[0].phoneNumberId, '1000000000001');
});

test('smb_message_echoes: messages sent from the phone app', () => {
  const ev = parseWebhook(wrap('smb_message_echoes', {
    messaging_product: 'whatsapp', metadata: META,
    message_echoes: [{ from: '77011112233', to: '77011234567', id: 'wamid.E', timestamp: '1760000200', type: 'text', text: { body: 'Добрый день!' } }]
  }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'echo');
  assert.equal(ev[0].direction, 'out');
  assert.equal(ev[0].waId, '77011234567');
  assert.equal(ev[0].msg.body, 'Добрый день!');
});

test('history sync: direction by sender vs business number', () => {
  const ev = parseWebhook(wrap('history', {
    messaging_product: 'whatsapp', metadata: META,
    history: [{
      metadata: { phase: 0, chunk_order: 1, progress: 10 },
      threads: [{
        id: '77011234567',
        messages: [
          { from: '77011234567', id: 'h1', timestamp: '1700000000', type: 'text', text: { body: 'старое' }, history_context: { status: 'READ' } },
          { from: '77011112233', id: 'h2', timestamp: '1700000050', type: 'text', text: { body: 'ответ' }, history_context: { status: 'DELIVERED' } }
        ]
      }]
    }]
  }));
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => [e.kind, e.direction, e.waId]), [['history', 'in', '77011234567'], ['history', 'out', '77011234567']]);
});

test('never throws on garbage', () => {
  for (const g of [null, undefined, 1, 'x', [], {}, { entry: 5 }, { entry: [null, 1, { changes: 'x' }] },
    { entry: [{ changes: [{ field: 'messages', value: { messages: [null, 5, { from: null }], statuses: [null] } }] }] },
    { entry: [{ changes: [{ field: 'history', value: { history: [{ threads: [{ messages: null }] }, null] } }] }] },
    { entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ to: null }] } }] }] }]) {
    assert.ok(Array.isArray(parseWebhook(g)));
  }
  assert.equal(parseMessage(null).type, 'other');
});

test('inbox hook: connector events map to the same normalized shape as the Cloud API parser', () => {
  const cloud = parseWebhook(inbound([{ from: '77011234567', id: 'wamid.A', timestamp: '1760000000', type: 'text', text: { body: 'Привет (A3)' } }]))[0];
  const [conn] = normalizeInboxEvents({ events: [{
    kind: 'message', numberPhone: '+7 701 111 22 33', waId: '77011234567', profileName: 'Айгерим',
    msg: { id: 'wamid.A', ts: 1760000000, type: 'text', body: 'Привет (A3)' }
  }] });
  assert.equal(conn.kind, cloud.kind);
  assert.equal(conn.direction, cloud.direction);
  assert.equal(conn.waId, cloud.waId);
  assert.equal(conn.profileName, cloud.profileName);
  assert.equal(conn.displayPhone, cloud.displayPhone);   // number identified by phone, not by phone_number_id
  assert.equal(conn.phoneNumberId, '');
  for (const k of ['id', 'ts', 'type', 'body', 'caption', 'voice']) assert.equal(conn.msg[k], cloud.msg[k], k);
});

test('inbox hook: echo, history, status, media url', () => {
  const ev = normalizeInboxEvents({ events: [
    { kind: 'echo', numberPhone: '77011112233', waId: '77011234567', msg: { id: 'e', ts: 1760000200, type: 'text', body: 'ok' } },
    { kind: 'history', direction: 'out', numberPhone: '77011112233', waId: '77011234567', msg: { id: 'h', ts: 1700000000, type: 'text', body: 'old' } },
    { kind: 'history', numberPhone: '77011112233', waId: '77011234567', msg: { id: 'h2', ts: 1700000000, type: 'text', body: 'old2' } },
    { kind: 'status', numberPhone: '77011112233', id: 'e', status: 'read', ts: 1760000300 },
    { kind: 'message', numberPhone: '77011112233', waId: '77011234567', msg: { id: 'v', ts: 1, type: 'voice', mediaUrl: 'https://conn.example/f/1.ogg', mime: 'audio/ogg' } },
    { kind: 'message', numberPhone: '77011112233', waId: '77011234567', msg: { id: 'x', ts: 1, type: 'weird', mediaUrl: 'javascript:alert(1)' } }
  ] });
  assert.deepEqual(ev.map((e) => [e.kind, e.direction]), [['echo', 'out'], ['history', 'out'], ['history', 'in'], ['status', undefined], ['message', 'in'], ['message', 'in']]);
  assert.equal(ev[3].status, 'read');
  assert.equal(ev[4].msg.voice, true);
  assert.equal(ev[4].msg.mediaUrl, 'https://conn.example/f/1.ogg');
  assert.equal(ev[5].msg.type, 'other');
  assert.equal(ev[5].msg.mediaUrl, '');
});

test('inbox hook: drops malformed events and never throws', () => {
  const ev = normalizeInboxEvents({ events: [
    null, 5, {}, { kind: 'message' }, { kind: 'message', numberPhone: '7701' }, { kind: 'message', numberPhone: '7701', waId: '77' },
    { kind: 'bogus', numberPhone: '7701', waId: '77', msg: {} }, { kind: 'status', numberPhone: '7701' }
  ] });
  assert.equal(ev.length, 0);
  for (const g of [null, undefined, 1, 'x', [], {}, { events: 'x' }]) assert.deepEqual(normalizeInboxEvents(g), []);
});

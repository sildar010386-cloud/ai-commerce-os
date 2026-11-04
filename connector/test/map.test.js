import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chatIdOf, describeContent, mapMessage, mapUpdates, mapReceipts, selectHistory, toNum, NOTE_BIG, NOTE_VIDEO, NOTE_HISTORY } from '../src/map.js';

const OWN = '77011112233';
const key = (o) => Object.assign({ remoteJid: '77011234567@s.whatsapp.net', fromMe: false, id: '3EB0A1' }, o);
const wam = (message, o) => Object.assign({ key: key(), message, messageTimestamp: 1760000000, pushName: 'Айгерим' }, o);
const map = (message, o, ctx) => mapMessage(wam(message, o), Object.assign({ ownPhone: OWN, kind: 'auto' }, ctx));

test('chatIdOf: 1:1, device suffix, groups and noise are filtered', () => {
  assert.deepEqual(chatIdOf({ remoteJid: '77011234567:12@s.whatsapp.net' }), { waId: '77011234567', lid: false });
  assert.equal(chatIdOf({ remoteJid: '120363@g.us' }), null);
  assert.equal(chatIdOf({ remoteJid: 'status@broadcast' }), null);
  assert.equal(chatIdOf({ remoteJid: '12345@broadcast' }), null);
  assert.equal(chatIdOf({ remoteJid: '1203@newsletter' }), null);
  assert.equal(chatIdOf({}), null);
  assert.equal(chatIdOf(null), null);
});

test('chatIdOf: @lid uses the phone-number alt jid when present, else the lid itself', () => {
  assert.deepEqual(chatIdOf({ remoteJid: '1234567890123@lid', remoteJidAlt: '77011234567@s.whatsapp.net' }),
    { waId: '77011234567', lid: false, lidUser: '1234567890123' });
  assert.deepEqual(chatIdOf({ remoteJid: '1234567890123@lid', senderPn: '77011234567@s.whatsapp.net' }).waId, '77011234567');
  assert.deepEqual(chatIdOf({ remoteJid: '1234567890123@lid' }), { waId: '1234567890123', lid: true, lidUser: '1234567890123' });
});

test('text: conversation and extendedText', () => {
  let r = map({ conversation: 'Здравствуйте (A3)' });
  assert.equal(r.event.kind, 'message');
  assert.equal(r.event.direction, 'in');
  assert.equal(r.event.numberPhone, OWN);
  assert.equal(r.event.waId, '77011234567');
  assert.equal(r.event.profileName, 'Айгерим');
  assert.deepEqual([r.event.msg.id, r.event.msg.ts, r.event.msg.type, r.event.msg.body], ['3EB0A1', 1760000000, 'text', 'Здравствуйте (A3)']);
  assert.equal(r.media, null);
  r = map({ extendedTextMessage: { text: 'ссылка https://x.kz', contextInfo: {} } });
  assert.equal(r.event.msg.type, 'text');
  assert.equal(r.event.msg.body, 'ссылка https://x.kz');
});

test('click-to-WhatsApp ad referral', () => {
  const r = map({ extendedTextMessage: { text: 'Хочу', contextInfo: { externalAdReply: { title: 'Отпариватель', body: 'Скидка', sourceUrl: 'https://fb.me/abc', sourceId: '99' } } } });
  assert.deepEqual(r.event.msg.referral, { source_url: 'https://fb.me/abc', source_type: 'ad', source_id: '99', headline: 'Отпариватель', body: 'Скидка' });
});

test('image with caption: media is requested when small', () => {
  const r = map({ imageMessage: { caption: 'Вот', mimetype: 'image/jpeg', fileLength: { low: 90000, high: 0 } } });
  assert.equal(r.event.msg.type, 'image');
  assert.equal(r.event.msg.caption, 'Вот');
  assert.equal(r.event.msg.mime, 'image/jpeg');
  assert.deepEqual(r.media, { kind: 'image', size: 90000, mime: 'image/jpeg' });
});

test('image above 1.5 MB gets a note instead of media', () => {
  const r = map({ imageMessage: { mimetype: 'image/jpeg', fileLength: 3 * 1024 * 1024 } });
  assert.equal(r.media, null);
  assert.equal(r.event.msg.body, NOTE_BIG);
});

test('voice note vs plain audio', () => {
  const v = map({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 5, fileLength: '20000' } });
  assert.equal(v.event.msg.type, 'voice');
  assert.equal(v.media.kind, 'voice');
  assert.equal(v.media.size, 20000);
  const a = map({ audioMessage: { mimetype: 'audio/mpeg', fileLength: 50000 } });
  assert.equal(a.event.msg.type, 'audio');
});

test('document: file name becomes the caption; big document gets a note', () => {
  const d = map({ documentMessage: { fileName: 'check.pdf', mimetype: 'application/pdf', fileLength: 10000 } });
  assert.equal(d.event.msg.type, 'document');
  assert.equal(d.event.msg.caption, 'check.pdf');
  assert.ok(d.media);
  const big = map({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'big.pdf', fileLength: 5e6, caption: 'смотрите' } } } });
  assert.equal(big.event.msg.type, 'document');
  assert.equal(big.event.msg.caption, 'смотрите');
  assert.equal(big.event.msg.body, NOTE_BIG);
});

test('sticker, video, location, reaction', () => {
  const s = map({ stickerMessage: { mimetype: 'image/webp', fileLength: 20000 } });
  assert.equal(s.event.msg.type, 'sticker');
  assert.ok(s.media);
  const v = map({ videoMessage: { caption: 'видео', mimetype: 'video/mp4', fileLength: 1000 } });
  assert.equal(v.event.msg.type, 'video');
  assert.equal(v.media, null);
  assert.equal(v.event.msg.body, NOTE_VIDEO);
  const l = map({ locationMessage: { degreesLatitude: 43.25, degreesLongitude: 76.9, name: 'Дом', address: 'Алматы' } });
  assert.equal(l.event.msg.type, 'location');
  assert.equal(l.event.msg.body, 'Дом · Алматы · 43.25,76.9');
  const r = map({ reactionMessage: { text: '👍', key: key() } });
  assert.equal(r.event.msg.type, 'reaction');
  assert.equal(r.event.msg.body, '👍');
  assert.equal(map({ reactionMessage: { text: '' } }), null);
});

test('wrappers: ephemeral and view-once are unwrapped', () => {
  const r = map({ ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: 'секрет' } } } } });
  assert.equal(r.event.msg.body, 'секрет');
});

test('protocol and unknown messages', () => {
  assert.equal(map({ protocolMessage: { type: 0 } }), null);
  assert.equal(map({ senderKeyDistributionMessage: {} }), null);
  assert.equal(map(null), null);
  assert.equal(map({ messageContextInfo: {} }), null);
  const u = map({ somethingNew: { a: 1 } });
  assert.equal(u.event.msg.type, 'other');
  const p = map({ pollCreationMessage: { name: 'Цвет?' } });
  assert.equal(p.event.msg.type, 'other');
  assert.equal(p.event.msg.body, 'Опрос: Цвет?');
  assert.equal(map({ contactMessage: { displayName: 'Иван' } }).event.msg.body, 'Контакт: Иван');
});

test('groups, status and newsletters are skipped', () => {
  for (const jid of ['1203@g.us', 'status@broadcast', '1@newsletter', '5@broadcast']) {
    assert.equal(map({ conversation: 'x' }, { key: key({ remoteJid: jid }) }), null, jid);
  }
});

test('fromMe -> echo, out; history kind; attachments in history carry a note', () => {
  const e = map({ conversation: 'ответ с телефона' }, { key: key({ fromMe: true }) });
  assert.equal(e.event.kind, 'echo');
  assert.equal(e.event.direction, 'out');
  assert.equal(e.event.profileName, '');
  const h = map({ imageMessage: { mimetype: 'image/jpeg', fileLength: 100 } }, {}, { kind: 'history' });
  assert.equal(h.event.kind, 'history');
  assert.equal(h.event.direction, 'in');
  assert.equal(h.media, null);
  assert.equal(h.event.msg.body, NOTE_HISTORY);
  const ho = map({ conversation: 'x' }, { key: key({ fromMe: true }) }, { kind: 'history' });
  assert.equal(ho.event.direction, 'out');
});

test('toNum handles Long-like values', () => {
  assert.equal(toNum({ low: 5, high: 0 }), 5);
  assert.equal(toNum({ low: 0, high: 1 }), 4294967296);
  assert.equal(toNum('12'), 12);
  assert.equal(toNum({ toNumber: () => 7 }), 7);
  assert.equal(toNum(undefined), 0);
});

test('status events from updates and receipts', () => {
  const k = key({ fromMe: true, id: 'OUT1' });
  const ev = mapUpdates([
    { key: k, update: { status: 2 } }, { key: k, update: { status: 3 } }, { key: k, update: { status: 4 } }, { key: k, update: { status: 0 } },
    { key: k, update: { status: 1 } }, { key: key({ fromMe: false }), update: { status: 4 } }, { key: key({ fromMe: true, remoteJid: '1@g.us' }), update: { status: 4 } }, null
  ], OWN);
  assert.deepEqual(ev.map((e) => e.status), ['sent', 'delivered', 'read', 'failed']);
  assert.equal(ev[0].id, 'OUT1');
  assert.equal(ev[0].numberPhone, OWN);
  const rc = mapReceipts([
    { key: k, receipt: { userJid: 'x@s.whatsapp.net', receiptTimestamp: 1760000100 } },
    { key: k, receipt: { userJid: 'x@s.whatsapp.net', readTimestamp: 1760000200 } },
    { key: key(), receipt: { readTimestamp: 1 } }
  ], OWN);
  assert.deepEqual(rc.map((e) => [e.status, e.ts]), [['delivered', 1760000100], ['read', 1760000200]]);
});

test('selectHistory: last 180 days, cap, oldest first', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const sec = now / 1000;
  const mk = (daysAgo, id) => ({ key: key({ id }), messageTimestamp: sec - daysAgo * 86400, message: { conversation: id } });
  const out = selectHistory([mk(200, 'old'), mk(10, 'a'), mk(1, 'b'), mk(100, 'c')], { now });
  assert.deepEqual(out.map((m) => m.key.id), ['c', 'a', 'b']);
  assert.deepEqual(selectHistory([mk(10, 'a'), mk(1, 'b'), mk(5, 'c')], { now, cap: 2 }).map((m) => m.key.id), ['c', 'b']);
});

test('describeContent never throws on garbage', () => {
  for (const g of [null, undefined, 5, 'x', [], { conversation: 5 }, { imageMessage: null }]) assert.doesNotThrow(() => describeContent(g));
});

test('mapped events are accepted by the CRM normalizer (same shape as the Cloud API parser output)', { skip: !fs.existsSync(new URL('../../crm/cf/src/wa.js', import.meta.url)) }, async () => {
  const { normalizeInboxEvents } = await import('../../crm/cf/src/wa.js');
  const r = map({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', fileLength: 1000 } });
  r.event.msg.mediaRef = 'm1';
  const [n] = normalizeInboxEvents({ events: [r.event] });
  assert.equal(n.kind, 'message');
  assert.equal(n.msg.type, 'voice');
  assert.equal(n.msg.voice, true);
  assert.equal(n.displayPhone, OWN);
  assert.equal(n.waId, '77011234567');
  assert.equal(n.msg.mediaRef, 'm1');
});

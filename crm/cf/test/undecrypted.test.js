// A WhatsApp message the connector could not decrypt, and chats that reach the CRM only through history although they are new.
// Worker API on a local D1 via miniflare (skipped when it is not installed). Run: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '../src');
let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';

const ORIGIN = 'http://crm.test';
let mf, db, cookie;

before(async () => {
  if (!Miniflare) return;
  mf = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'fx.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'testdb' }, bindings: { CRM_API_KEY: 'test-api-key-0123456789' }
  });
  db = await mf.getD1Database('DB');
  const dir = path.join(__dirname, '../migrations');
  for (const f of fs.readdirSync(dir).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
  }
  let r = await mf.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: { 'X-Api-Key': 'test-api-key-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.kz', name: 'Админ', password: 'long-password-123' }) });
  assert.equal(r.status, 201);
  r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'a@b.kz', password: 'long-password-123' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { if (mf) await mf.dispose(); });

const admin = (method, p, body) => mf.dispatchFetch(ORIGIN + p, {
  method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body)
});
let TOKEN = '';
const conn = (method, p, body, token) => mf.dispatchFetch(ORIGIN + p, {
  method, headers: Object.assign({ Authorization: 'Bearer ' + (token === undefined ? TOKEN : token) }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  body: body === undefined ? undefined : JSON.stringify(body)
});
const j = async (r) => r.json();
const b64 = (s) => Buffer.from(s).toString('base64');
const QR = 'data:image/png;base64,iVBORw0KGgo=';
const ev = (o) => Object.assign({ kind: 'message', numberPhone: '77011112233', waId: '77019998877', profileName: 'Клиент' }, o);


const NOTE = 'Сообщение не расшифровалось — откройте этот чат на телефоне';
const contactOf = (waId) => db.prepare("SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?").bind(waId).first();
const msgOf = (id) => db.prepare('SELECT * FROM messages WHERE ext_msg_id = ?').bind(id).first();

test('undecryptable first message: the chat appears at once (unread, organic for now); the real message replaces the note and decides the source', { skip }, async () => {
  TOKEN = (await j(await admin('POST', '/api/wa-server/key', {}))).script.match(/CONNECTOR_TOKEN=(\S+)/)[1];
  await db.prepare("INSERT INTO target_texts (product_name, code, text, active, created_at, updated_at) VALUES ('Отпариватель', 'A1', 'Здравствуйте, хочу заказать отпариватель', 1, '2026-01-01', '2026-01-01')").run();
  const nowS = Math.floor(Date.now() / 1000);
  let r = await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550010', profileName: 'Гульнар', msg: { id: 'U1', ts: nowS - 60, type: 'other', body: 'anything', undecrypted: true } })] });
  assert.equal(r.status, 200, await r.text());
  let c = await contactOf('77015550010');
  assert.equal(c.traffic, 'organic');
  assert.equal(c.unread, 1);
  assert.equal(c.name, 'Гульнар');
  assert.equal((await msgOf('U1')).body, NOTE);
  // a repeat of the placeholder changes nothing
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550010', msg: { id: 'U1', ts: nowS - 60, type: 'other', undecrypted: true } })] });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE ext_msg_id = 'U1'").first()).n, 1);
  // WhatsApp delivers it again, decrypted: the text replaces the note, the pre-filled ad text makes it a target client
  r = await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550010', msg: { id: 'U1', ts: nowS - 60, type: 'text', body: 'Здравствуйте, хочу заказать отпариватель' } })] });
  assert.equal(r.status, 200);
  const m = await msgOf('U1');
  assert.equal(m.type, 'text');
  assert.equal(m.body, 'Здравствуйте, хочу заказать отпариватель');
  c = await contactOf('77015550010');
  assert.equal(c.traffic, 'target');
  assert.equal(c.target_code, 'A1');
  assert.equal(c.last_preview, 'Здравствуйте, хочу заказать отпариватель');
  assert.equal(c.unread, 1, 'still one unread message, not two');
  // a real message is never overwritten by a placeholder with the same id
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550010', msg: { id: 'U1', ts: nowS - 60, type: 'other', undecrypted: true } })] });
  assert.equal((await msgOf('U1')).body, 'Здравствуйте, хочу заказать отпариватель');
  // a source set by hand is never changed
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550011', msg: { id: 'U2', ts: nowS - 50, type: 'other', undecrypted: true } })] });
  await db.prepare("UPDATE contacts SET source_manual = 1 WHERE ext_id = '77015550011'").run();
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550011', msg: { id: 'U2', ts: nowS - 50, type: 'text', body: 'Здравствуйте, хочу заказать отпариватель' } })] });
  assert.equal((await contactOf('77015550011')).traffic, 'organic');
  assert.equal((await msgOf('U2')).type, 'text');
});

test('history brings the real content of a placeholder; a chat that STARTED within 72 h and reached the CRM through history is a new client', { skip }, async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const H = (waId, id, ts, o) => Object.assign({ kind: 'history', numberPhone: '77011112233', waId, profileName: '', direction: 'in', msg: { id, ts, type: 'text', body: 'старое ' + id } }, o);
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77015550020', msg: { id: 'U3', ts: nowS - 300, type: 'other', undecrypted: true } })] });
  let r = await conn('POST', '/api/connector/events', { events: [
    H('77015550020', 'U3', nowS - 300, { msg: { id: 'U3', ts: nowS - 300, type: 'text', body: 'Сколько стоит?' } }),
    // missed overnight: first message 8 h ago, the client wrote last -> target + unread
    H('77015550030', 'N1', nowS - 8 * 3600, { profileName: 'Айжан', msg: { id: 'N1', ts: nowS - 8 * 3600, type: 'text', body: 'Здравствуйте, хочу заказать отпариватель' } }),
    // missed, organic, we already answered from the phone -> organic, not unread
    H('77015550031', 'N2', nowS - 6 * 3600, { msg: { id: 'N2', ts: nowS - 6 * 3600, type: 'text', body: 'Добрый вечер, есть доставка?' } }),
    H('77015550031', 'N3', nowS - 5 * 3600, { direction: 'out', msg: { id: 'N3', ts: nowS - 5 * 3600, type: 'text', body: 'Да' } }),
    // an old client: first message 10 days ago -> stays «Старый»
    H('77015550032', 'O1', nowS - 10 * 86400),
    H('77015550032', 'O2', nowS - 3600)
  ] });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await msgOf('U3')).body, 'Сколько стоит?');
  let c = await contactOf('77015550030');
  assert.equal(c.traffic, 'target'); assert.equal(c.target_code, 'A1'); assert.equal(c.unread, 1); assert.equal(c.name, 'Айжан');
  c = await contactOf('77015550031');
  assert.equal(c.traffic, 'organic'); assert.equal(c.unread, 0);
  c = await contactOf('77015550032');
  assert.equal(c.traffic, 'old'); assert.equal(c.unread, 0);
  // the same history again (re-import) does not touch chats that already exist, even after the owner changed them
  await db.prepare("UPDATE contacts SET unread = 0 WHERE ext_id = '77015550030'").run();
  await db.prepare("UPDATE contacts SET traffic = 'old' WHERE ext_id = '77015550031'").run();
  r = await conn('POST', '/api/connector/events', { events: [H('77015550030', 'N1', nowS - 8 * 3600, { msg: { id: 'N1', ts: nowS - 8 * 3600, type: 'text', body: 'Здравствуйте, хочу заказать отпариватель' } }), H('77015550031', 'N2', nowS - 6 * 3600)] });
  assert.equal(r.status, 200);
  assert.equal((await contactOf('77015550030')).unread, 0);
  assert.equal((await contactOf('77015550031')).traffic, 'old');
});

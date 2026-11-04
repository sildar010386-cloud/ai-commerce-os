// Older WhatsApp messages on demand: queue rules, rate limits, history_done, ordering, chats without messages, 4500 alias events,
// and one end-to-end run (REAL connector code <-> REAL CRM worker on miniflare, fake WhatsApp socket answering fetchMessageHistory).
// The worker runs behind a thin wrapper that COUNTS its D1 calls per request (headers x-d1-queries / x-d1-statements / x-d1-rows):
// the Cloudflare free plan allows 50 subrequests (each D1 call, a DB.batch is one call) per request.
// Run: node --test test/*.test.js   (skipped without miniflare)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const SRC = path.join(__dirname, '../src');
const CONN = path.join(__dirname, '../../../connector/src');
let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';

const ORIGIN = 'http://crm.test';
let mf, db, cookie, TOKEN = '', bridgeMod, queueMod, crmMod;
const NOW = Math.floor(Date.now() / 1000);
const PH = '77011112233';

const WRAPPER = `
import real from './worker_real.js';
const wrapStmt = (s, c, sql) => ({
  __real: s,
  bind(...a) { return wrapStmt(s.bind(...a), c, sql); },
  async run() { c.q++; c.st++; const r = await s.run(); c.rows += (r.meta && r.meta.rows_written) || 0; if (c.trace && r.meta && r.meta.rows_written) console.log('ROWS', r.meta.rows_written, sql.slice(0, 90)); return r; },
  async all() { c.q++; c.st++; const r = await s.all(); c.rows += (r.meta && r.meta.rows_written) || 0; return r; },
  async first(...a) { c.q++; c.st++; return s.first(...a); },
  async raw(...a) { c.q++; c.st++; return s.raw(...a); }
});
const wrapDb = (db, c) => ({
  prepare(sql) { return wrapStmt(db.prepare(sql), c, sql); },
  async batch(list) { c.q++; c.st += list.length; const r = await db.batch(list.map((x) => x.__real || x)); r.forEach((x, i) => { c.rows += (x.meta && x.meta.rows_written) || 0; if (c.trace && x.meta && x.meta.rows_written) console.log('ROWS', x.meta.rows_written, 'batch', i); }); return r; }
});
export default {
  async fetch(req, env, ctx) {
    const c = { q: 0, st: 0, rows: 0, trace: !!env.TRACE_ROWS };
    const res = await real.fetch(req, Object.assign({}, env, { DB: wrapDb(env.DB, c) }), ctx);
    const h = new Headers(res.headers);
    h.set('x-d1-queries', String(c.q)); h.set('x-d1-statements', String(c.st)); h.set('x-d1-rows', String(c.rows));
    return new Response(res.body, { status: res.status, headers: h });
  }
};`;

const applySql = async (file) => {
  const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
  for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
};
before(async () => {
  if (!Miniflare) return;
  const mods = ['wa.js', 'source.js', 'fx.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') }));
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'entry.js', contents: WRAPPER }, { type: 'ESModule', path: 'worker_real.js', contents: fs.readFileSync(path.join(SRC, 'worker.js'), 'utf8') }].concat(mods),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'testdb' }, bindings: { CRM_API_KEY: 'test-api-key-0123456789', TRACE_ROWS: process.env.TRACE_ROWS || '' }
  });
  db = await mf.getD1Database('DB');
  const dir = path.join(__dirname, '../migrations');
  for (const f of fs.readdirSync(dir).sort()) await applySql(path.join(dir, f));
  let r = await mf.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: { 'X-Api-Key': 'test-api-key-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.kz', name: 'Админ', password: 'long-password-123' }) });
  assert.equal(r.status, 201);
  r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'a@b.kz', password: 'long-password-123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  const k = await (await admin('POST', '/api/wa-server/key', {})).json();
  TOKEN = k.script.match(/CONNECTOR_TOKEN=(\S+)/)[1];
  await conn('POST', '/api/connector/state', { state: 'open', phone: PH, name: 'Bikas', version: '1.0.0' });
  bridgeMod = await import(pathToFileURL(path.join(CONN, 'bridge.js')).href);
  queueMod = await import(pathToFileURL(path.join(CONN, 'queue.js')).href);
  crmMod = await import(pathToFileURL(path.join(CONN, 'crm.js')).href);
});
after(async () => { if (mf) await mf.dispose(); });

const admin = (method, p, body) => mf.dispatchFetch(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const conn = (method, p, body) => mf.dispatchFetch(ORIGIN + p, { method, headers: Object.assign({ Authorization: 'Bearer ' + TOKEN }, body !== undefined ? { 'Content-Type': 'application/json' } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
const chatsList = async () => (await (await admin('GET', '/api/chats')).json()).chats;
const open = async (id) => (await admin('GET', '/api/chats/' + id)).json();
const stat = (r) => ({ q: Number(r.headers.get('x-d1-queries')), st: Number(r.headers.get('x-d1-statements')), rows: Number(r.headers.get('x-d1-rows')) });
const tick = () => new Promise((r) => setImmediate(r));
const hist = (waId, id, ago, text, extra) => Object.assign({ kind: 'history', numberPhone: PH, waId, profileName: 'Клиент ' + waId, direction: id.endsWith('o') ? 'out' : 'in', chatJid: waId + '@s.whatsapp.net',
  msg: { id, ts: NOW - ago, type: 'text', body: text || id } }, extra || {});
const post = async (events) => { const r = await conn('POST', '/api/connector/events', { events }); assert.equal(r.status, 200, await r.clone().text()); return stat(r); };
const idOf = async (ext) => (await db.prepare("SELECT id FROM contacts WHERE ext_id = ?").bind(ext).first()).id;
const contactRow = (ext) => db.prepare('SELECT * FROM contacts WHERE ext_id = ?').bind(ext).first();
const histItems = async (cid) => (await db.prepare("SELECT * FROM outbox WHERE type = 'history' AND contact_id = ? ORDER BY id").bind(cid).all()).results;
const resetLimits = () => db.prepare("DELETE FROM outbox WHERE type = 'history'").run();
const stats = {};   // measured numbers, printed at the end

test('GET of a short thread queues ONE history request: payload = chat jid + oldest message (id, fromMe, ms) + count 50; chat jid is stored', { skip }, async () => {
  await post([hist('77070000001', 'a1', 300, 'раньше'), hist('77070000001', 'a2o', 200, 'ответ'), hist('77070000001', 'a3', 100, 'позже')]);
  const cid = await idOf('77070000001');
  assert.equal((await contactRow('77070000001')).wa_jid, '77070000001@s.whatsapp.net');
  const d = await open(cid);
  assert.equal(d.messages.length, 3);
  assert.equal(d.chat.historyPending, true);
  assert.equal(d.chat.historyDone, false);
  const items = await histItems(cid);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'queued');
  assert.deepEqual(JSON.parse(items[0].text), { chatJid: '77070000001@s.whatsapp.net', oldest: { id: 'a1', fromMe: false, tsMs: (NOW - 300) * 1000 }, count: 50, bestEffort: false });
  assert.ok((await contactRow('77070000001')).history_requested_at);
  // a second open does not add another one (pending / recent)
  await open(cid); await open(cid);
  assert.equal((await histItems(cid)).length, 1);
  // the connector gets it as an item of type history with the payload fields
  const o = await (await conn('GET', '/api/connector/outbox?ready=1')).json();
  const it = o.items.find((x) => x.type === 'history' && x.to === '77070000001');
  assert.deepEqual([it.chatJid, it.oldest, it.count, it.bestEffort, it.text], ['77070000001@s.whatsapp.net', { id: 'a1', fromMe: false, tsMs: (NOW - 300) * 1000 }, 50, false, undefined]);
  // ok-ack keeps the request pending until the phone answers; the button does not add another one either
  assert.equal((await conn('POST', '/api/connector/ack', { id: it.id, ok: true, extMsgId: 'REQ1' })).status, 200);
  assert.equal((await open(cid)).chat.historyPending, true);
  const r = await admin('POST', `/api/chats/${cid}/older`, {});
  assert.equal(r.status, 200); assert.equal((await r.json()).pending, true);
  assert.equal((await histItems(cid)).length, 1);
});

test('no request when: 30+ messages, history_done, connector offline, not a QR number; the button says why', { skip }, async () => {
  await resetLimits();
  const evs = [];
  for (let i = 0; i < 30; i++) evs.push(hist('77070000002', 'b' + i, 5000 - i, 'm' + i));
  for (let i = 0; i < evs.length; i += 15) await post(evs.slice(i, i + 15));
  const c30 = await idOf('77070000002');
  await open(c30);
  assert.equal((await histItems(c30)).length, 0, '30 messages: the thread is long enough');
  // the button still works for a long thread
  assert.equal((await admin('POST', `/api/chats/${c30}/older`, {})).status, 200);
  assert.equal((await histItems(c30)).length, 1);

  await post([hist('77070000003', 'c1', 100, 'один')]);
  const cd = await idOf('77070000003');
  await db.prepare('UPDATE contacts SET history_done = 1 WHERE id = ?').bind(cd).run();
  const d = await open(cd);
  assert.deepEqual([d.chat.historyDone, (await histItems(cd)).length], [true, 0]);
  const r = await admin('POST', `/api/chats/${cd}/older`, {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'Более ранних сообщений нет');

  await post([hist('77070000004', 'd1', 100, 'один')]);
  const co = await idOf('77070000004');
  const row = await db.prepare('SELECT last_seen_at FROM connector WHERE id = 1').first();
  await db.prepare("UPDATE connector SET last_seen_at = ?").bind(new Date(Date.now() - 10 * 60000).toISOString()).run();
  await open(co);
  assert.equal((await histItems(co)).length, 0, 'connector offline: nothing queued');
  const r2 = await admin('POST', `/api/chats/${co}/older`, {});
  assert.equal(r2.status, 409);
  assert.match((await r2.json()).error, /не на связи/);
  await db.prepare("UPDATE connector SET last_seen_at = ?").bind(row.last_seen_at).run();
  await conn('POST', '/api/connector/state', { state: 'open', phone: PH, name: 'Bikas', version: '1.0.0' });
});

test('rules: auto request at most once per 10 min per chat; the button ignores that gap but not "pending"; a failed ack ends "pending", a retry waits 10 min', { skip }, async () => {
  await resetLimits();
  await post([hist('77070000005', 'e1', 100, 'один')]);
  const cid = await idOf('77070000005');
  await open(cid);
  let items = await histItems(cid);
  assert.equal(items.length, 1);
  // claim + failed ack
  const o = await (await conn('GET', '/api/connector/outbox?ready=1')).json();
  const it = o.items.find((x) => x.type === 'history' && x.to === '77070000005');
  await conn('POST', '/api/connector/ack', { id: it.id, ok: false, error: 'no anchor' });
  assert.equal((await histItems(cid))[0].status, 'failed');
  let d = await open(cid);
  assert.equal(d.chat.historyPending, false, 'a failed request is not pending any more');
  assert.equal((await histItems(cid)).length, 1, 'but the automatic retry waits 10 min');
  // the button asks right away
  assert.equal((await admin('POST', `/api/chats/${cid}/older`, {})).status, 200);
  assert.equal((await histItems(cid)).length, 2);
  // 11 minutes later the automatic request works again (pending request answered first)
  const eleven = new Date(Date.now() - 11 * 60000).toISOString();
  await db.prepare("UPDATE outbox SET status = 'sent' WHERE contact_id = ?").bind(cid).run();
  await db.prepare('UPDATE contacts SET history_requested_at = ?, history_answered_at = ? WHERE id = ?').bind(eleven, eleven, cid).run();
  await open(cid);
  assert.equal((await histItems(cid)).length, 3);
  // an unanswered request stops being pending after 5 minutes
  const six = new Date(Date.now() - 6 * 60000).toISOString();
  await db.prepare("UPDATE outbox SET status = 'sent' WHERE contact_id = ?").bind(cid).run();
  await db.prepare("UPDATE contacts SET history_requested_at = ?, history_answered_at = '' WHERE id = ?").bind(six, cid).run();
  d = await open(cid);
  assert.equal(d.chat.historyPending, false);
});

test('rate limits: 20 requests per 10 min overall (automatic ones are skipped, the button answers 429), 60 per 24 h', { skip }, async () => {
  await resetLimits();
  await db.prepare('UPDATE contacts SET history_done = 0, history_requested_at = \'\', history_answered_at = \'\'').run();
  const ids = [];
  for (let i = 0; i < 22; i++) { await post([hist('7707111' + String(1000 + i), 'r' + i, 100, 'x')]); ids.push(await idOf('7707111' + String(1000 + i))); }
  for (const id of ids) await open(id);
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'history'").first()).n;
  assert.equal(n, 20, 'the 21st and 22nd chat did not queue');
  const extra = ids[21];
  const r = await admin('POST', `/api/chats/${extra}/older`, {});
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /Слишком много запросов/);
  // 10 minutes pass: allowed again
  await db.prepare("UPDATE outbox SET created_at = ?, status = 'sent' WHERE type = 'history'").bind(new Date(Date.now() - 11 * 60000).toISOString()).run();
  assert.equal((await admin('POST', `/api/chats/${extra}/older`, {})).status, 200);
  // daily limit: 100 within 24 h
  await db.prepare("UPDATE outbox SET status = 'sent'").run();
  for (let i = 0; i < 99; i++) {
    await db.prepare("INSERT INTO outbox (contact_id, number_id, to_ext, type, text, status, created_at, updated_at) VALUES (?, 1, 'x', 'history', '{}', 'sent', ?, ?)").bind(ids[0], new Date(Date.now() - 30 * 60000).toISOString(), new Date().toISOString()).run();
  }
  await db.prepare("UPDATE contacts SET history_requested_at = '', history_answered_at = ''").run();
  const r2 = await admin('POST', `/api/chats/${ids[3]}/older`, {});
  assert.equal(r2.status, 429);
  assert.match((await r2.json()).error, /лимит/);
  await resetLimits();
});

test('history_result: done only when nothing older than the anchor arrived; older messages come oldest-first and keep the thread order', { skip }, async () => {
  await resetLimits();
  await post([hist('77070000007', 'f1', 1000, 'три'), hist('77070000007', 'f2', 900, 'четыре')]);
  const cid = await idOf('77070000007');
  await open(cid);
  const [req] = await histItems(cid);
  const anchor = NOW - 1000;
  // 50 older messages arrive (several batches of 15), then the result: not done, answered
  const older = [];
  for (let i = 0; i < 50; i++) older.push(hist('77070000007', 'g' + i, 5000 - i * 10, 'старое ' + i, { kind: 'history' }));   // g0 oldest ... g49 newest (still older than f1)
  for (let i = 0; i < older.length; i += 15) await post(older.slice(i, i + 15));
  await post([{ kind: 'history_result', numberPhone: PH, outboxId: req.id, anchorTs: anchor, chatJid: '77070000007@s.whatsapp.net' }]);
  let c = await contactRow('77070000007');
  assert.deepEqual([c.history_done, !!c.history_answered_at], [0, true]);
  let d = await open(cid);
  assert.equal(d.chat.historyPending, false);
  assert.equal(d.messages.length, 52);
  assert.deepEqual(d.messages.slice(0, 3).map((m) => m.body), ['старое 0', 'старое 1', 'старое 2']);
  assert.deepEqual(d.messages.slice(-2).map((m) => m.body), ['три', 'четыре'], 'the old page sits above the newest ones');
  const ts = d.messages.map((m) => m.ts);
  assert.deepEqual(ts, [...ts].sort(), 'oldest first');
  assert.equal(c.first_message_at, d.messages[0].ts);
  // the next request has a new anchor; an empty answer -> done
  await resetLimits();
  await admin('POST', `/api/chats/${cid}/older`, {});
  const [req2] = await histItems(cid);
  assert.equal(JSON.parse(req2.text).oldest.id, 'g0', 'the anchor moved to the new oldest message');
  await post([{ kind: 'history_result', numberPhone: PH, outboxId: req2.id, anchorTs: NOW - 5000, chatJid: '77070000007@s.whatsapp.net' }]);
  c = await contactRow('77070000007');
  assert.equal(c.history_done, 1);
  d = await open(cid);
  assert.deepEqual([d.chat.historyDone, d.chat.historyPending], [true, false]);
  assert.equal((await histItems(cid)).length, 1, 'no more requests for a done chat');
});

test('chat events: a chat without messages appears (traffic old, name, last message time, chat jid), repeated events change nothing, messages later fill it', { skip }, async () => {
  await resetLimits();
  const ev = { kind: 'chat', numberPhone: PH, waId: '77070000008', chatJid: '77070000008@s.whatsapp.net', profileName: 'Пустой чат', lastTs: NOW - 7200 };
  const s1 = await post([ev, Object.assign({}, ev, { waId: '77070000009', profileName: '', chatJid: '77070000009@s.whatsapp.net' })]);
  const list = await chatsList();
  const c = list.find((x) => x.phone === '77070000008');
  assert.ok(c);
  assert.deepEqual([c.name, c.traffic, c.preview, c.unread], ['Пустой чат', 'old', '', 0]);
  assert.equal(new Date(c.lastAt).getTime(), (NOW - 7200) * 1000);
  const row = await contactRow('77070000008');
  assert.deepEqual([row.wa_jid, row.first_message_at], ['77070000008@s.whatsapp.net', '']);
  // repeated: the upsert does not rewrite the row
  const s2 = await post([ev]);
  assert.ok(s2.rows <= 1, 'an unchanged chat event writes nothing but the number\'s last_seen_at row (rows: ' + s2.rows + ')');
  assert.ok(s1.rows > 0);
  // lid-only chat event
  await post([{ kind: 'chat', numberPhone: PH, waId: '99887766554433', lid: '99887766554433', chatJid: '99887766554433@lid', profileName: 'Скрытый', lastTs: NOW - 10 }]);
  const lc = (await chatsList()).find((x) => x.name === 'Скрытый');
  assert.deepEqual([lc.idKind, lc.phone], ['lid', '']);
  // asking for older messages of a chat without messages: best effort, empty id, last time + 1 s
  const cid = await idOf('77070000008');
  const d = await open(cid);
  assert.equal(d.messages.length, 0);
  const [req] = await histItems(cid);
  assert.deepEqual(JSON.parse(req.text), { chatJid: '77070000008@s.whatsapp.net', oldest: { id: '', fromMe: false, tsMs: (NOW - 7200) * 1000 + 1000 }, count: 50, bestEffort: true });
  // the phone returns nothing -> done, the UI says the messages are only on the phone
  await post([{ kind: 'history_result', numberPhone: PH, outboxId: req.id, anchorTs: NOW - 7200 + 1, chatJid: '77070000008@s.whatsapp.net' }]);
  const d2 = await open(cid);
  assert.deepEqual([d2.chat.historyDone, d2.messages.length], [true, 0]);
  // if the phone does answer: messages -> not done
  await post([{ kind: 'chat', numberPhone: PH, waId: '77070000010', chatJid: '77070000010@s.whatsapp.net', profileName: 'Другой', lastTs: NOW - 100 }]);
  const c2 = await idOf('77070000010');
  await open(c2);
  const [rq2] = await histItems(c2);
  await post([hist('77070000010', 'z1', 400, 'нашлось')]);
  await post([{ kind: 'history_result', numberPhone: PH, outboxId: rq2.id, anchorTs: NOW - 100 + 1, chatJid: '77070000010@s.whatsapp.net' }]);
  assert.equal((await contactRow('77070000010')).history_done, 0);
  assert.equal((await contactRow('77070000010')).first_message_at.length > 0, true);
});

test('diagnostics and the connector last error are shown in Settings data', { skip }, async () => {
  await conn('POST', '/api/connector/state', { state: 'open', phone: PH, name: 'Bikas', version: '1.0.0', lastError: 'dropped [alias x6] 400 {"error":"boom"}' });
  const d = await (await admin('GET', '/api/wa-server')).json();
  assert.equal(d.server.lastError, 'dropped [alias x6] 400 {"error":"boom"}');
  assert.ok(d.server.lastErrorAt);
  for (const k of ['contacts', 'withPhone', 'lidOnly', 'messages', 'aliases', 'historyPending', 'historyDone', 'historyFailed']) assert.equal(typeof d.diag[k], 'number', k);
  assert.equal(d.diag.contacts, d.diag.withPhone + d.diag.lidOnly);
  assert.ok(d.diag.messages > 0 && d.diag.historyDone >= 1);
  await conn('POST', '/api/connector/state', { state: 'open', phone: PH, name: 'Bikas', version: '1.0.0', lastError: '' });
  assert.equal((await (await admin('GET', '/api/wa-server')).json()).server.lastError, '');
  // the page code shows the block with Russian labels
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  for (const t of ['Диагностика', 'Чатов всего', 'С номером телефона', 'Номер скрыт (только lid)', 'Сообщений всего', 'Сохранено связок lid', 'Последняя ошибка программы', 'Загрузить более ранние сообщения', 'Загружаю…', 'Старые сообщения есть только на телефоне']) assert.ok(app.includes(t), t);
});

test('4500 alias events (real queue batch size) against ~500 lid chats with messages: all merged, each request within the free-plan limits', { skip }, async () => {
  await resetLimits();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  const lidOf = (i) => String(30000000000000 + i), phoneOf = (i) => String(77060000000 + i);
  // 500 lid-only chats with 3 messages each (as a history import without mappings leaves them); 100 of them have a phone contact already
  const evs = [];
  for (let i = 0; i < 500; i++) for (let m = 0; m < 3; m++) evs.push(hist(lidOf(i), `L${i}_${m}`, 5000 + m * 10, 'lid ' + i, { lid: lidOf(i), chatJid: lidOf(i) + '@lid' }));
  for (let i = 0; i < 100; i++) evs.push(hist(phoneOf(i), `P${i}_0`, 100, 'phone ' + i));
  const log = [];
  const makeQueue = (send) => queueMod.createEventQueue({ file: path.join(dir, 'q' + log.length + '.jsonl'), send, log: { warn: (m) => log.push(m) } });
  const reqStats = [];
  const send = async (events) => {
    const r = await conn('POST', '/api/connector/events', { events });
    const kinds = new Set(events.map((e) => e.kind));
    reqStats.push(Object.assign(stat(r), { kind: [...kinds].sort().join('+'), n: events.length }));
    if (!r.ok) { const e = new Error('CRM ' + r.status); e.status = r.status; e.body = await r.text(); throw e; }
  };
  const q1 = makeQueue(send);
  await q1.push(evs);
  assert.equal(q1.size(), 0, log.join('\n'));
  const lids = (await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id_kind = 'lid' AND ext_id >= '30000000000000' AND ext_id < '30000000000500'").first()).n;
  assert.equal(lids, 500, 'imported as lid-only chats');
  const hmax = reqStats.filter((x) => x.kind === 'history');
  // 4500 alias events: the 500 real ones + 4000 that no chat belongs to, shuffled, in the queue's alias batch size
  const al = [];
  for (let i = 0; i < 500; i++) al.push({ kind: 'alias', numberPhone: PH, lid: lidOf(i), phone: phoneOf(i) });
  for (let i = 0; i < 4000; i++) al.push({ kind: 'alias', numberPhone: PH, lid: String(31000000000000 + i), phone: String(77050000000 + i) });
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = al.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [al[i], al[j]] = [al[j], al[i]]; }
  reqStats.length = 0;
  const q2 = makeQueue(send);
  await q2.push(al);
  assert.equal(q2.size(), 0, 'every alias batch was accepted: ' + log.slice(0, 3).join(' | '));
  assert.equal(log.length, 0);
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id_kind = 'lid' AND ext_id >= '30000000000000' AND ext_id < '30000000000500'").first()).n;
  assert.equal(left, 0, 'no lid chat is left unmerged');
  const merged = await db.prepare("SELECT COUNT(*) AS n FROM contacts c WHERE c.ext_id >= '77060000000' AND c.ext_id < '77060000500' AND (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id) >= 3").first();
  assert.equal(merged.n, 500, 'all 500 phone contacts hold the 3 messages of their lid chat (the 100 pre-existing ones merged, the rest renamed)');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE ext_msg_id LIKE 'L%'").first()).n, 1500, 'no message lost');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM wa_alias").first()).n >= 4500, true);
  const A = reqStats.filter((x) => x.kind === 'alias');
  const max = (k) => Math.max(...A.map((x) => x[k]));
  assert.equal(A.length, 750, '4500 aliases / 6 per request');
  stats.alias = { requests: A.length, maxQueries: max('q'), maxStatements: max('st'), maxRows: max('rows') };
  stats.history15 = { maxQueries: Math.max(...hmax.map((x) => x.q)), maxStatements: Math.max(...hmax.map((x) => x.st)), maxRows: Math.max(...hmax.map((x) => x.rows)), requests: hmax.length };
  assert.ok(stats.alias.maxQueries <= 40, 'alias request queries ' + stats.alias.maxQueries);
  assert.ok(stats.history15.maxQueries <= 40, 'history request queries ' + stats.history15.maxQueries);
  // a second pass (the final alias pass of the connector) changes nothing and writes no rows
  reqStats.length = 0;
  const q3 = makeQueue(send);
  await q3.push(al.slice(0, 600));
  assert.ok(reqStats.reduce((a, x) => a + x.rows, 0) <= reqStats.length, 'repeating known aliases writes no rows but one last_seen_at row per request');
});

test('rows per message (free plan: 100k rows written per day): a 15-message batch into a new chat and into an existing one', { skip }, async () => {
  const mk = (w, n, off) => Array.from({ length: n }, (_, i) => hist(w, `${w}_${off + i}`, 90000 + off + i, 'm'));
  const s1 = await post(mk('77070099001', 15, 0));
  const s2 = await post(mk('77070099001', 15, 15));
  stats.rowsNewChat15 = s1; stats.rowsOldChat15 = s2;
  const per = s2.rows / 15;
  console.log('# 15 messages, new chat:', JSON.stringify(s1), '| 15 more, same chat:', JSON.stringify(s2), '| rows per message', per.toFixed(2));
  assert.ok(s1.q <= 40 && s2.q <= 40);
  assert.ok(per >= 2 && per <= 5, 'rows per message ' + per);
});

// ---------------------------------------------------------------------------------------------------------------------------
// End to end: REAL connector code <-> REAL CRM worker. The fake socket answers fetchMessageHistory like the phone: an ON_DEMAND
// messaging-history.set with 50 older messages (and, the second time, with nothing).
test('END TO END: GET opens a short thread -> request -> connector calls fetchMessageHistory -> ON_DEMAND answer (50 older messages) -> thread returns them oldest-first -> next answer empty -> done', { skip }, async () => {
  await resetLimits();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const fetchImpl = (url, init) => mf.dispatchFetch(url, init);
  const crm = crmMod.createCrm({ url: ORIGIN, token: TOKEN, fetchImpl, retries: 0, sleep: async () => {} });
  const queue = queueMod.createEventQueue({ file: path.join(dir, 'q.jsonl'), send: (e) => crm.events(e), log: { warn() {} } });
  const sock = { ev: new EventEmitter(), user: { id: PH + ':5@s.whatsapp.net', name: 'Bikas' }, end() {}, logout: async () => {}, sendMessage: async () => ({ key: { id: 'S' } }), fetches: [] };
  const JID = '77070055001@s.whatsapp.net';
  let page = 0;
  const olderPage = (oldestTs, n) => Array.from({ length: 50 }, (_, i) => ({
    key: { remoteJid: JID, id: `OLD${n}_${i}`, fromMe: i % 3 === 0 }, message: { conversation: `старое ${n}-${i}` }, messageTimestamp: oldestTs - (50 - i) * 60
  }));
  sock.fetchMessageHistory = async (count, key, tsMs) => {
    sock.fetches.push({ count, key, tsMs });
    const reqId = 'REQ' + sock.fetches.length, n = page++;
    setTimeout(() => sock.ev.emit('messaging-history.set', {
      chats: [], contacts: [], syncType: 6, peerDataRequestSessionId: reqId,
      messages: n === 0 ? olderPage(Math.floor(tsMs / 1000), n) : []      // the first answer: 50 older messages, the second: nothing
    }), 20);
    return reqId;
  };
  const bridge = bridgeMod.createBridge({
    crm, queue, stateDir: dir, version: 't', log: { info() {}, warn() {}, error() {} }, makeSocket: async () => sock, wipeAuth: async () => {}, renderQr: async () => '',
    downloadMedia: async () => Buffer.alloc(1), prepareVoice: async (b) => ({ audio: b }), sleep: async () => {}, random: () => 0, finalPassMs: 3600000
  });
  await bridge.connect();
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick(); await tick();
  const settle = async () => { for (let i = 0; i < 40; i++) { await tick(); await new Promise((r) => setTimeout(r, 5)); } await queue.flush(); };
  // the pairing sync brought the 5 newest messages of the chat
  sock.ev.emit('messaging-history.set', { chats: [], contacts: [], syncType: 3, progress: 50,
    messages: Array.from({ length: 5 }, (_, i) => ({ key: { remoteJid: JID, id: `NEW${i}`, fromMe: i % 2 === 0 }, message: { conversation: `новое ${i}` }, messageTimestamp: NOW - 3000 + i * 60, pushName: 'Бауыржан' })) });
  await settle();
  const cid = await idOf('77070055001');
  assert.equal((await open(cid)).messages.length, 5, 'opening the thread queued a request');
  await bridge.pollOnce();
  await settle();
  assert.equal(sock.fetches.length, 1);
  assert.deepEqual(sock.fetches[0], { count: 50, key: { remoteJid: JID, fromMe: true, id: 'NEW0' }, tsMs: (NOW - 3000) * 1000 });
  let d = await open(cid);
  assert.equal(d.messages.length, 55);
  assert.deepEqual(d.messages.slice(0, 2).map((m) => m.body), ['старое 0-0', 'старое 0-1'], 'oldest first');
  assert.deepEqual(d.messages.slice(48, 52).map((m) => m.body), ['старое 0-48', 'старое 0-49', 'новое 0', 'новое 1']);
  const tss = d.messages.map((m) => m.ts);
  assert.deepEqual(tss, [...tss].sort());
  assert.equal(d.chat.historyPending, false);
  assert.equal(d.chat.historyDone, false, '50 new messages came: more may exist');
  assert.equal((await db.prepare("SELECT status FROM outbox WHERE type = 'history' AND contact_id = ?").bind(cid).first()).status, 'sent');
  // the button: second request, the anchor is the oldest message now; the phone has nothing more -> done
  assert.equal((await admin('POST', `/api/chats/${cid}/older`, {})).status, 200);
  await bridge.pollOnce();
  await settle();
  assert.equal(sock.fetches.length, 2);
  assert.equal(sock.fetches[1].key.id, 'OLD0_0');
  d = await open(cid);
  assert.deepEqual([d.messages.length, d.chat.historyDone, d.chat.historyPending], [55, true, false]);
  assert.equal((await admin('POST', `/api/chats/${cid}/older`, {})).status, 409);
  console.log('# measured D1 numbers:', JSON.stringify(stats));
});

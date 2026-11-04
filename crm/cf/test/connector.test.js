// Tests of the QR connector side of the CRM: generated cloud-init module (always) and the Worker API on a local D1 via
// miniflare (skipped when wrangler/miniflare is not installed). Run: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../src');
const TEMPLATE = path.join(__dirname, '../../../connector/cloud-init.template.sh');

test('connector_script.js is the generated copy of connector/cloud-init.template.sh (single source of truth)', async () => {
  if (!fs.existsSync(TEMPLATE)) return;
  const { CLOUD_INIT_TEMPLATE } = await import(require('url').pathToFileURL(path.join(SRC, 'connector_script.js')).href);
  assert.equal(CLOUD_INIT_TEMPLATE, fs.readFileSync(TEMPLATE, 'utf8'), 'run: node scripts/gen-cloud-init.js');
  assert.equal((CLOUD_INIT_TEMPLATE.match(/__CRM_URL__/g) || []).length, 1);
  assert.equal((CLOUD_INIT_TEMPLATE.match(/__CONNECTOR_TOKEN__/g) || []).length, 1);
});

let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';

const ORIGIN = 'http://crm.test';
let mf, db, cookie;

before(async () => {
  if (!Miniflare) return;
  mf = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'connector_script.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
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

test('connector API refuses requests without a valid key (also before any key exists)', { skip }, async () => {
  assert.equal((await conn('GET', '/api/connector/outbox', undefined, 'x'.repeat(40))).status, 401);
  assert.equal((await mf.dispatchFetch(ORIGIN + '/api/connector/outbox')).status, 401);
});

test('admin creates the key: script is filled in, only the hash is stored, a new key invalidates the old one', { skip }, async () => {
  let r = await admin('POST', '/api/wa-server/key', {});
  assert.equal(r.status, 200);
  const d = await j(r);
  const m = d.script.match(/CONNECTOR_TOKEN=(\S+)/);
  assert.ok(m && /^[A-Za-z0-9_-]{43}$/.test(m[1]), 'token is 32 random bytes in base64url');
  assert.ok(d.script.includes('CRM_URL=' + ORIGIN));
  assert.ok(!d.script.includes('__CRM_URL__') && !d.script.includes('__CONNECTOR_TOKEN__'));
  TOKEN = m[1];
  const row = await db.prepare('SELECT token_hash FROM connector WHERE id = 1').first();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, TOKEN);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0')).status, 200);
  const old = TOKEN;
  const d2 = await j(await admin('POST', '/api/wa-server/key', {}));
  TOKEN = d2.script.match(/CONNECTOR_TOKEN=(\S+)/)[1];
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0', undefined, old)).status, 401);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0')).status, 200);
});

test('wa-server API is admin only and never leaks the key', { skip }, async () => {
  const st = await j(await admin('GET', '/api/wa-server'));
  assert.equal(st.server.installed, true);
  assert.ok(!JSON.stringify(st).includes(TOKEN));
  assert.equal((await mf.dispatchFetch(ORIGIN + '/api/wa-server')).status, 401);
});

test('state qr: QR is kept and shown; bad QR payload is ignored', { skip }, async () => {
  assert.equal((await conn('POST', '/api/connector/state', { state: 'qr', qr: QR, version: '1.0.0' })).status, 200);
  let s = (await j(await admin('GET', '/api/wa-server'))).server;
  assert.deepEqual([s.state, s.online, s.qr, s.version], ['qr', true, QR, '1.0.0']);
  await conn('POST', '/api/connector/state', { state: 'qr', qr: 'javascript:alert(1)' });
  s = (await j(await admin('GET', '/api/wa-server'))).server;
  assert.equal(s.qr, QR);
  assert.equal((await conn('POST', '/api/connector/state', { state: 'bogus' })).status, 400);
});

test('state open creates the number, makes it current (first number), clears the QR', { skip }, async () => {
  await conn('POST', '/api/connector/state', { state: 'open', phone: '+7 701 111 22 33', name: 'Bikas', version: '1.0.0' });
  const n = await db.prepare('SELECT * FROM wa_numbers').all();
  assert.equal(n.results.length, 1);
  assert.deepEqual([n.results[0].phone, n.results[0].connection, n.results[0].status, n.results[0].is_current], ['77011112233', 'qr', 'active', 1]);
  const s = (await j(await admin('GET', '/api/wa-server'))).server;
  assert.deepEqual([s.state, s.phone, s.name, s.qr], ['open', '77011112233', 'Bikas', '']);
  assert.equal((await j(await admin('GET', '/api/me'))).waConnected, true);
});

test('events: inbound message, echo and status go through the shared ingest', { skip }, async () => {
  const r = await conn('POST', '/api/connector/events', { events: [
    ev({ msg: { id: 'IN1', ts: 1760000000, type: 'text', body: 'Здравствуйте' } }),
    ev({ kind: 'message', msg: { id: 'IN2', ts: 1760000010, type: 'voice', mime: 'audio/ogg; codecs=opus' } }),
    ev({ kind: 'echo', msg: { id: 'ECHO1', ts: 1760000020, type: 'text', body: 'ответ с телефона' } })
  ] });
  assert.equal((await j(r)).accepted, 3);
  const chats = (await j(await admin('GET', '/api/chats'))).chats;
  assert.equal(chats.length, 1);
  assert.equal(chats[0].numberConnection, 'qr');
  const t = await j(await admin('GET', '/api/chats/' + chats[0].id));
  assert.deepEqual(t.messages.map((m) => [m.type, m.direction, m.fromApp]), [['text', 'in', false], ['voice', 'in', false], ['text', 'out', true]]);
  // same events again are idempotent
  await conn('POST', '/api/connector/events', { events: [ev({ msg: { id: 'IN1', ts: 1760000000, type: 'text', body: 'Здравствуйте' } })] });
  assert.equal((await j(await admin('GET', '/api/chats/' + chats[0].id))).messages.length, 3);
});

test('inbound media: connector uploads, event carries mediaRef, /api/media serves it with Range', { skip }, async () => {
  const up = await j(await conn('POST', '/api/connector/media', { mime: 'audio/ogg; codecs=opus', data: b64('0123456789') }));
  assert.match(up.id, /^[0-9a-f]{24}$/);
  await conn('POST', '/api/connector/events', { events: [ev({ msg: { id: 'IN3', ts: 1760000100, type: 'voice', mime: 'audio/ogg; codecs=opus', mediaRef: up.id } })] });
  const chat = (await j(await admin('GET', '/api/chats'))).chats[0];
  const msgs = (await j(await admin('GET', '/api/chats/' + chat.id))).messages;
  const m = msgs.find((x) => x.hasMedia);
  assert.ok(m);
  let r = await mf.dispatchFetch(ORIGIN + '/api/media/' + m.id, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/ogg');
  assert.equal(await r.text(), '0123456789');
  r = await mf.dispatchFetch(ORIGIN + '/api/media/' + m.id, { headers: { Cookie: cookie, Range: 'bytes=2-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await r.text(), '2345');
  assert.equal((await mf.dispatchFetch(ORIGIN + '/api/media/' + m.id)).status, 401);
  // connector reads its own uploads back
  r = await conn('GET', '/api/connector/media/' + up.id);
  assert.equal(await r.text(), '0123456789');
  // size limit
  const big = await conn('POST', '/api/connector/media', { mime: 'image/jpeg', data: Buffer.alloc(1536 * 1024 + 10).toString('base64') });
  assert.equal(big.status, 413);
});

let chatId, firstOutId;
test('sending text through a QR number queues it: message "queued", outbox claimed once, ack makes it "sent"', { skip }, async () => {
  chatId = (await j(await admin('GET', '/api/chats'))).chats[0].id;
  let r = await admin('POST', `/api/chats/${chatId}/send`, { text: 'Добрый день!' });
  assert.equal(r.status, 200);
  let d = await j(r);
  assert.equal(d.message.status, 'queued');
  assert.equal(d.warning, '');
  // not ready -> nothing handed out
  assert.deepEqual((await j(await conn('GET', '/api/connector/outbox?ready=0'))).items, []);
  const o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.command, null);
  assert.equal(o.items.length, 1);
  assert.deepEqual([o.items[0].to, o.items[0].type, o.items[0].text], ['77019998877', 'text', 'Добрый день!']);
  firstOutId = o.items[0].id;
  assert.equal((await j(await conn('GET', '/api/connector/outbox?ready=1'))).items.length, 0, 'claimed items are not handed out twice');
  assert.equal((await conn('POST', '/api/connector/ack', { id: firstOutId, ok: true, extMsgId: 'OUT-A' })).status, 200);
  const msgs = (await j(await admin('GET', '/api/chats/' + chatId))).messages;
  const mine = msgs.find((x) => x.body === 'Добрый день!');
  assert.equal(mine.status, 'sent');
  // delivery receipt from the phone
  await conn('POST', '/api/connector/events', { events: [{ kind: 'status', numberPhone: '77011112233', id: 'OUT-A', status: 'read', ts: 1760000500 }] });
  assert.equal((await j(await admin('GET', '/api/chats/' + chatId))).messages.find((x) => x.body === 'Добрый день!').status, 'read');
});

test('the echo of a CRM-sent message does not duplicate it', { skip }, async () => {
  await conn('POST', '/api/connector/events', { events: [ev({ kind: 'echo', msg: { id: 'OUT-A', ts: 1760000600, type: 'text', body: 'Добрый день!' } })] });
  const msgs = (await j(await admin('GET', '/api/chats/' + chatId))).messages;
  assert.equal(msgs.filter((x) => x.body === 'Добрый день!').length, 1);
});

test('voice and image from the CRM: stored in D1, queued with mediaRef, fetchable by the connector', { skip }, async () => {
  let r = await admin('POST', `/api/chats/${chatId}/voice`, { data: b64('OggS-fake-voice'), mime: 'audio/webm;codecs=opus' });
  assert.equal(r.status, 200);
  let d = await j(r);
  assert.equal(d.message.type, 'voice');
  assert.equal(d.message.hasMedia, true);
  r = await admin('POST', `/api/chats/${chatId}/image`, { data: b64('\x89PNG-fake'), mime: 'image/png', caption: 'Вот фото' });
  assert.equal(r.status, 200);
  const o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.deepEqual(o.items.map((i) => [i.type, i.text]), [['voice', ''], ['image', 'Вот фото']]);
  const media = await conn('GET', '/api/connector/media/' + o.items[0].mediaRef);
  assert.equal(await media.text(), 'OggS-fake-voice');
  assert.match(media.headers.get('content-type'), /audio\/webm/);
  for (const i of o.items) await conn('POST', '/api/connector/ack', { id: i.id, ok: true, extMsgId: 'M' + i.id });
  // validation
  assert.equal((await admin('POST', `/api/chats/${chatId}/voice`, { data: b64('x'), mime: 'text/html' })).status, 400);
  assert.equal((await admin('POST', `/api/chats/${chatId}/image`, { data: b64('x'), mime: 'image/svg+xml' })).status, 400);
  assert.equal((await admin('POST', `/api/chats/${chatId}/voice`, { data: Buffer.alloc(1536 * 1024 + 10).toString('base64'), mime: 'audio/ogg' })).status, 413);
});

test('failed ack marks the message failed; "not connected" is retried; stale claims are requeued, then fail after 3 attempts', { skip }, async () => {
  await admin('POST', `/api/chats/${chatId}/send`, { text: 'fail me' });
  let o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  await conn('POST', '/api/connector/ack', { id: o.items[0].id, ok: false, error: 'not connected' });
  o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.items.length, 1, 'requeued after "not connected"');
  await conn('POST', '/api/connector/ack', { id: o.items[0].id, ok: false, error: 'bad recipient' });
  let msgs = (await j(await admin('GET', '/api/chats/' + chatId))).messages;
  assert.equal(msgs.find((x) => x.body === 'fail me').status, 'failed');

  await admin('POST', `/api/chats/${chatId}/send`, { text: 'stale me' });
  const old = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
    assert.equal(o.items.length, 1, 'attempt ' + attempt);
    await db.prepare("UPDATE outbox SET updated_at = ? WHERE status = 'sending'").bind(old).run();
  }
  o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.items.length, 0);
  msgs = (await j(await admin('GET', '/api/chats/' + chatId))).messages;
  assert.equal(msgs.find((x) => x.body === 'stale me').status, 'failed');
});

test('connector offline for > 2 min: still queued, with the Russian warning', { skip }, async () => {
  await db.prepare('UPDATE connector SET last_seen_at = ? WHERE id = 1').bind(new Date(Date.now() - 5 * 60 * 1000).toISOString()).run();
  const d = await j(await admin('POST', `/api/chats/${chatId}/send`, { text: 'offline' }));
  assert.equal(d.message.status, 'queued');
  assert.equal(d.warning, 'Сервер WhatsApp не на связи — сообщение уйдёт, когда он появится');
  const s = (await j(await admin('GET', '/api/wa-server'))).server;
  assert.equal(s.online, false);
  assert.ok(s.minutesAgo >= 5);
});

test('relink: command is handed out once; old-number heartbeat does not switch; new number becomes current; old one is "not connected"', { skip }, async () => {
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77011112233' });   // alive again
  assert.equal((await admin('POST', '/api/wa-server/relink', {})).status, 200);
  const row = await db.prepare('SELECT pending_command, switch_on_open FROM connector WHERE id = 1').first();
  assert.deepEqual([row.pending_command, row.switch_on_open], ['relink', 1]);
  assert.equal((await j(await admin('GET', '/api/wa-server'))).server.relinkPending, true);
  // a heartbeat of the old session arriving before the command was delivered changes nothing
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77011112233' });
  assert.equal((await db.prepare('SELECT switch_on_open FROM connector WHERE id = 1').first()).switch_on_open, 1);
  let o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.command, 'relink');
  assert.deepEqual(o.items, []);
  o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.command, null, 'delivered once');
  await conn('POST', '/api/connector/state', { state: 'logged_out' });
  await conn('POST', '/api/connector/state', { state: 'qr', qr: QR });
  // the same old number reappearing (late heartbeat) still does not switch
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77011112233' });
  assert.equal((await db.prepare("SELECT is_current FROM wa_numbers WHERE phone = '77011112233'").first()).is_current, 1);
  // a new phone scans the QR
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677', name: 'Запасной' });
  const nums = (await db.prepare('SELECT phone, connection, is_current, status FROM wa_numbers ORDER BY id').all()).results;
  assert.deepEqual(nums.map((n) => [n.phone, n.connection, n.is_current]), [['77011112233', '', 0], ['77055556677', 'qr', 1]]);
  assert.equal((await db.prepare('SELECT switch_on_open FROM connector WHERE id = 1').first()).switch_on_open, 0);
  const audit = await db.prepare("SELECT actor, action FROM audit WHERE action = 'wa-current'").all();
  assert.ok(audit.results.length >= 2);
  // public links follow the new number
  const link = await mf.dispatchFetch(ORIGIN + '/wa', { redirect: 'manual' });
  assert.equal(link.status, 302);
  assert.match(link.headers.get('location'), /wa\.me\/77055556677/);
});

test('after the switch: queued messages of the old number never leave through the new one; old-number chats cannot send', { skip }, async () => {
  const q = (await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('queued', 'sending')").first()).n;
  assert.equal(q, 0);
  const o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.deepEqual(o.items, []);
  const r = await admin('POST', `/api/chats/${chatId}/send`, { text: 'старый номер' });
  assert.equal(r.status, 503);   // chat belongs to the old number, which is no longer connected
});

test('security headers: CSP allows data:/blob: images and blob: media only; microphone allowed for self', { skip }, async () => {
  const r = await mf.dispatchFetch(ORIGIN + '/api/me');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: blob:;/);
  assert.match(csp, /media-src 'self' blob:;/);
  assert.match(csp, /script-src 'self';/);
  assert.match(r.headers.get('permissions-policy'), /microphone=\(self\)/);
});

test('legacy paths keep working: CONNECTOR_URL send for a QR number without a connector key, Cloud API send', { skip }, async () => {
  const seen = [];
  const mf2 = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'connector_script.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'legacy' },
    bindings: { CRM_API_KEY: 'test-api-key-0123456789', CONNECTOR_URL: 'https://legacy.example/', CONNECTOR_KEY: 'ck', WA_TOKEN: 'wat' },
    outboundService: async (req) => {
      const body = await req.json();
      seen.push([req.url, req.headers.get('x-api-key') || req.headers.get('authorization'), body]);
      return Response.json(req.url.includes('graph.facebook.com') ? { messages: [{ id: 'wamid.CLOUD' }] } : { id: 'LEGACY1' });
    }
  });
  try {
    const d = await mf2.getD1Database('DB');
    const dir = path.join(__dirname, '../migrations');
    for (const f of fs.readdirSync(dir).sort()) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
      for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await d.prepare(st).run();
    }
    const h = { 'X-Api-Key': 'test-api-key-0123456789', 'Content-Type': 'application/json' };
    await mf2.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: h, body: JSON.stringify({ email: 'a@b.kz', name: 'A', password: 'long-password-123' }) });
    const lg = await mf2.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'a@b.kz', password: 'long-password-123' }) });
    const ck = lg.headers.get('set-cookie').split(';')[0];
    const post = (p, b) => mf2.dispatchFetch(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: ck }, body: JSON.stringify(b) });
    // old inbox hook: number gets connection 'qr', no connector key exists
    await mf2.dispatchFetch(ORIGIN + '/api/hooks/inbox', { method: 'POST', headers: h, body: JSON.stringify({ events: [{ kind: 'message', numberPhone: '77011112233', waId: '77019998877', msg: { id: 'L1', ts: 1760000000, type: 'text', body: 'hi' } }] }) });
    const chat = (await (await mf2.dispatchFetch(ORIGIN + '/api/chats', { headers: { Cookie: ck } })).json()).chats[0];
    let r = await post(`/api/chats/${chat.id}/send`, { text: 'через старый коннектор' });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.message.status, 'sent');
    assert.equal(seen[0][0], 'https://legacy.example/send');
    assert.equal(seen[0][1], 'ck');
    // voice needs the new connector
    r = await post(`/api/chats/${chat.id}/voice`, { data: b64('x'), mime: 'audio/ogg' });
    assert.equal(r.status, 409);
    // Cloud API route: number with phone_number_id + WA_TOKEN
    await d.prepare("UPDATE wa_numbers SET phone_number_id = '555', connection = 'cloud'").run();
    await d.prepare("UPDATE contacts SET last_inbound_at = ?").bind(new Date().toISOString()).run();
    r = await post(`/api/chats/${chat.id}/send`, { text: 'через cloud' });
    assert.equal(r.status, 200);
    assert.match(seen[1][0], /graph\.facebook\.com\/v21\.0\/555\/messages/);
    assert.equal(seen[1][2].text.body, 'через cloud');
  } finally { await mf2.dispose(); }
});

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

const WIN_TEMPLATE = path.join(__dirname, '../../../connector/windows/setup.template.cmd');
const INSTALL_SH = path.join(__dirname, '../../../connector/install.sh');

test('connector_windows.js is the generated copy of connector/windows/setup.template.cmd (single source of truth)', async () => {
  if (!fs.existsSync(WIN_TEMPLATE)) return;
  const { WINDOWS_SETUP_TEMPLATE: T } = await import(require('url').pathToFileURL(path.join(SRC, 'connector_windows.js')).href);
  const src = fs.readFileSync(WIN_TEMPLATE, 'utf8');
  assert.ok(!src.includes('\r'), 'the source file is LF; the Worker converts to CRLF when serving');
  assert.equal(T, src, 'run: node scripts/gen-windows-setup.js');
  assert.equal((T.match(/__CRM_URL__/g) || []).length, 1);
  assert.equal((T.match(/__CONNECTOR_TOKEN__/g) || []).length, 1);
  // the batch part (everything before the PowerShell payload) is plain ASCII and ends with exit /b
  const head = T.split(/^#PAYLOAD\s*$/m)[0];
  assert.ok(/^[\x00-\x7f]*$/.test(head), 'batch part must be ASCII');
  assert.ok(/\nexit \/b %BK_RC%\n$/.test(head));
  assert.ok(/-ExecutionPolicy Bypass/.test(head) && /-NoProfile/.test(head));
  assert.equal(T.split(/^#PAYLOAD\s*$/m).length, 2, 'exactly one payload marker line');
});

test('Windows installer pins the same Node.js version as install.sh and the same branch as the Linux scripts', () => {
  if (!fs.existsSync(WIN_TEMPLATE) || !fs.existsSync(INSTALL_SH)) return;
  const t = fs.readFileSync(WIN_TEMPLATE, 'utf8'), sh = fs.readFileSync(INSTALL_SH, 'utf8');
  const v = sh.match(/^NODE_VERSION=(\S+)/m)[1];
  assert.ok(t.includes("$NodeVersion = '" + v + "'"), 'Node ' + v);
  const br = sh.match(/BIKAS_BRANCH:-([^}]+)\}/)[1];
  assert.ok(t.includes("$Branch = '" + br + "'"), 'branch ' + br);
  assert.ok(t.includes('SHASUMS256.txt') && t.includes('Get-FileHash'), 'SHA256 of the Node zip is verified');
});

test('PowerShell parts of the Windows installer parse without errors (needs pwsh; skipped otherwise)', (t) => {
  const { spawnSync } = require('child_process');
  const pw = process.env.PWSH || 'pwsh';
  if (spawnSync(pw, ['-NoProfile', '-Command', '1']).status !== 0) return t.skip('pwsh is not installed');
  const T = fs.readFileSync(WIN_TEMPLATE, 'utf8');
  const payload = T.split(/^#PAYLOAD\s*$/m)[1];
  const tools = payload.match(/\$ToolsPs1 = @'\n([\s\S]*?)\n'@/)[1];
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-'));
  const files = { 'payload.ps1': payload, 'tools.ps1': tools };
  for (const f of Object.keys(files)) fs.writeFileSync(path.join(dir, f), files[f]);
  const script = "foreach ($f in $args) { $e = $null; $k = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$k, [ref]$e); if ($e.Count) { $e | ForEach-Object { $f + ': ' + $_.Message + ' line ' + $_.Extent.StartLineNumber }; exit 1 } }";
  fs.writeFileSync(path.join(dir, 'parse.ps1'), script);
  const r = spawnSync(pw, ['-NoProfile', '-File', path.join(dir, 'parse.ps1'), ...Object.keys(files).map((f) => path.join(dir, f))], { encoding: 'utf8', env: Object.assign({}, process.env, { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';

const ORIGIN = 'http://crm.test';
let mf, db, cookie;

before(async () => {
  if (!Miniflare) return;
  mf = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
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

test('Windows installer: admin only, new key each time (old one dies), values substituted, CRLF, attachment, no-store', { skip }, async () => {
  const oldToken = TOKEN;
  // a manager must not get it (and must not rotate the key)
  const mgrMail = 'mgr@b.kz', mgrPass = 'manager-password-1';
  let r = await admin('POST', '/api/users', { email: mgrMail, name: 'Менеджер', password: mgrPass });
  assert.equal(r.status, 201);
  r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: mgrMail, password: mgrPass }) });
  const mgrCookie = r.headers.get('set-cookie').split(';')[0];
  const asMgr = await mf.dispatchFetch(ORIGIN + '/api/wa-server/windows-installer', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: mgrCookie }, body: '{}' });
  assert.equal(asMgr.status, 403);
  const anon = await mf.dispatchFetch(ORIGIN + '/api/wa-server/windows-installer', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' });
  assert.equal(anon.status, 401);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0')).status, 200, 'the key still works after the refused requests');
  // CSRF: a request from another origin is refused
  const evil = await mf.dispatchFetch(ORIGIN + '/api/wa-server/windows-installer', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test', Cookie: cookie }, body: '{}' });
  assert.equal(evil.status, 403);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0')).status, 200);

  r = await admin('POST', '/api/wa-server/windows-installer', {});
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="BikasWhatsApp-setup\.cmd"$/);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const body = Buffer.from(await r.arrayBuffer()).toString('utf8');
  const m = body.match(/\$Token = '([A-Za-z0-9_-]+)'/);
  assert.ok(m && m[1].length === 43, 'token substituted');
  assert.ok(body.includes("$CrmUrl = '" + ORIGIN + "'"));
  assert.ok(!body.includes('__CRM_URL__') && !body.includes('__CONNECTOR_TOKEN__'));
  assert.ok(!/(^|[^\r])\n/.test(body), 'every line ends with CRLF');
  assert.ok(body.startsWith('@echo off\r\n'));
  assert.notEqual(m[1], oldToken);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0', undefined, oldToken)).status, 401, 'old key invalidated');
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0', undefined, m[1])).status, 200, 'new key works');
  const row = await db.prepare('SELECT token_hash FROM connector WHERE id = 1').first();
  assert.notEqual(row.token_hash, m[1]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'wa-server-key' AND detail = 'windows'").first()).n >= 1, true);
  TOKEN = m[1];
  // GET is not accepted (a key must never be rotated by a link)
  assert.notEqual((await admin('GET', '/api/wa-server/windows-installer')).status, 200);
  assert.equal((await conn('GET', '/api/connector/outbox?ready=0')).status, 200);
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

// older-history requests are covered by history_ondemand.test.js; here a chat opened in the thread must not queue one
const quiet = async () => { await db.prepare('UPDATE contacts SET history_done = 1').run(); await db.prepare("DELETE FROM outbox WHERE type = 'history'").run(); };
let chatId, firstOutId;
test('sending text through a QR number queues it: message "queued", outbox claimed once, ack makes it "sent"', { skip }, async () => {
  await quiet();
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
  await quiet();
  await conn('POST', '/api/connector/events', { events: [ev({ kind: 'echo', msg: { id: 'OUT-A', ts: 1760000600, type: 'text', body: 'Добрый день!' } })] });
  const msgs = (await j(await admin('GET', '/api/chats/' + chatId))).messages;
  assert.equal(msgs.filter((x) => x.body === 'Добрый день!').length, 1);
});

test('voice and image from the CRM: stored in D1, queued with mediaRef, fetchable by the connector', { skip }, async () => {
  const wave = Buffer.from(Array.from({ length: 64 }, (_, i) => i)).toString('base64');
  let r = await admin('POST', `/api/chats/${chatId}/voice`, { data: b64('OggS-fake-voice'), mime: 'audio/webm;codecs=opus', seconds: 6.4, waveform: wave });
  assert.equal(r.status, 200);
  let d = await j(r);
  assert.equal(d.message.type, 'voice');
  assert.equal(d.message.hasMedia, true);
  r = await admin('POST', `/api/chats/${chatId}/image`, { data: b64('\x89PNG-fake'), mime: 'image/png', caption: 'Вот фото' });
  assert.equal(r.status, 200);
  const o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.deepEqual(o.items.map((i) => [i.type, i.text]), [['voice', ''], ['image', 'Вот фото']]);
  assert.deepEqual([o.items[0].seconds, o.items[0].waveform, o.items[1].seconds, o.items[1].waveform], [6, wave, 0, '']);
  const media = await conn('GET', '/api/connector/media/' + o.items[0].mediaRef);
  assert.equal(await media.text(), 'OggS-fake-voice');
  assert.match(media.headers.get('content-type'), /audio\/webm/);
  for (const i of o.items) await conn('POST', '/api/connector/ack', { id: i.id, ok: true, extMsgId: 'M' + i.id });
  // validation
  // a broken waveform is ignored, the voice is still accepted
  r = await admin('POST', `/api/chats/${chatId}/voice`, { data: b64('OggS-x'), mime: 'audio/ogg', seconds: 'abc', waveform: 'zzz' });
  assert.equal(r.status, 200);
  const o2 = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.deepEqual([o2.items[0].seconds, o2.items[0].waveform], [0, '']);
  await conn('POST', '/api/connector/ack', { id: o2.items[0].id, ok: true, extMsgId: 'M-v2' });
  assert.equal((await admin('POST', `/api/chats/${chatId}/voice`, { data: b64('x'), mime: 'text/html' })).status, 400);
  assert.equal((await admin('POST', `/api/chats/${chatId}/image`, { data: b64('x'), mime: 'image/svg+xml' })).status, 400);
  assert.equal((await admin('POST', `/api/chats/${chatId}/voice`, { data: Buffer.alloc(1536 * 1024 + 10).toString('base64'), mime: 'audio/ogg' })).status, 413);
});

test('failed ack marks the message failed; "not connected" is retried; stale claims are requeued, then fail after 3 attempts', { skip }, async () => {
  await quiet();
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

test('history: old chats arrive in small batches, become «Старый» chats sorted by last message, idempotent, no unread, names applied', { skip }, async () => {
  const H = (waId, id, ts, o) => Object.assign({ kind: 'history', numberPhone: '77011112233', waId, profileName: '', direction: 'in', msg: { id, ts, type: 'text', body: 'старое ' + id } }, o);
  const batch1 = [
    H('77070000001', 'HA1', 1750000000, { profileName: 'Алия' }),
    H('77070000001', 'HA2', 1750000100, { direction: 'out' }),
    H('77070000001', 'HA3', 1750000200, { msg: { id: 'HA3', ts: 1750000200, type: 'image', body: 'вложение из истории — откройте на телефоне', caption: 'фото' } }),
    H('77070000002', 'HB1', 1755000000, { direction: 'out', msg: { id: 'HB1', ts: 1755000000, type: 'text', body: 'Добрый день' } }),
    H('77070000003', 'HC1', 1740000000),
    { kind: 'contact', numberPhone: '77011112233', waId: '77070000002', profileName: 'Берик' },
    { kind: 'contact', numberPhone: '77011112233', waId: '77070000999', profileName: 'Нет такого чата' }
  ];
  let r = await conn('POST', '/api/connector/events', { events: batch1 });
  assert.equal(r.status, 200);
  const before = (await j(await admin('GET', '/api/chats'))).chats;
  const old = before.filter((c) => c.traffic === 'old');
  assert.deepEqual(old.map((c) => c.phone), ['77070000002', '77070000001', '77070000003'], 'sorted by last message, newest first');
  assert.deepEqual(old.map((c) => c.name), ['Берик', 'Алия', '']);
  assert.ok(old.every((c) => c.unread === 0));
  assert.equal(old[1].preview, '[Фото] фото');
  assert.equal(old[0].preview, 'Вы: Добрый день');
  // the same batch again (connector retry) changes nothing
  r = await conn('POST', '/api/connector/events', { events: batch1 });
  assert.equal(r.status, 200);
  const t = await j(await admin('GET', '/api/chats/' + old[1].id));
  assert.deepEqual(t.messages.map((m) => [m.type, m.direction]), [['text', 'in'], ['text', 'out'], ['image', 'in']]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE ext_id = '77070000999'").first()).n, 0, 'a name alone does not create a chat');
  // older messages arrive later (next history chunk): first_message_at moves back, the summary stays on the newest
  await conn('POST', '/api/connector/events', { events: [H('77070000001', 'HA0', 1745000000)] });
  const row = await db.prepare("SELECT first_message_at, last_message_at FROM contacts WHERE ext_id = '77070000001'").first();
  assert.ok(row.first_message_at < row.last_message_at);
  assert.equal(new Date(row.first_message_at).getTime(), 1745000000000);
  assert.equal(new Date(row.last_message_at).getTime(), 1750000200000);
  // filter «Старые»; live traffic stays out of it
  const only = (await j(await admin('GET', '/api/chats?filter=old'))).chats;
  assert.ok(only.length >= 3 && only.every((c) => c.traffic === 'old'));
  // a live message from an old chat keeps working: unread grows, the chat jumps to the top
  await conn('POST', '/api/connector/events', { events: [ev({ waId: '77070000003', msg: { id: 'LIVE-C', ts: 1999999999, type: 'text', body: 'снова здравствуйте' } })] });
  const after = (await j(await admin('GET', '/api/chats'))).chats;
  assert.equal(after[0].phone, '77070000003');
  assert.equal(after[0].unread, 1);
  // a big mixed batch (as the old connector sent: 100 events) is still accepted
  const many = [];
  for (let i = 0; i < 100; i++) many.push(H('77071' + String(i).padStart(6, '0'), 'BIG' + i, 1730000000 + i));
  r = await conn('POST', '/api/connector/events', { events: many });
  assert.equal(r.status, 200);
  assert.equal((await j(await admin('GET', '/api/chats?filter=old'))).chats.length >= 103, true);
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

test('«Загрузить старые чаты заново»: relink command for the SAME phone, the current number is not switched', { skip }, async () => {
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677' });
  assert.equal((await admin('POST', '/api/wa-server/reload-history', {})).status, 200);
  let row = await db.prepare('SELECT pending_command, switch_on_open, state FROM connector WHERE id = 1').first();
  assert.deepEqual([row.pending_command, row.switch_on_open, row.state], ['relink', 0, 'relinking']);
  const o = await j(await conn('GET', '/api/connector/outbox?ready=1'));
  assert.equal(o.command, 'relink');
  await conn('POST', '/api/connector/state', { state: 'logged_out' });
  await conn('POST', '/api/connector/state', { state: 'qr', qr: QR });
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677', name: 'Запасной' });
  const nums = (await db.prepare('SELECT phone, connection, is_current FROM wa_numbers ORDER BY id').all()).results;
  assert.deepEqual(nums.map((n) => [n.phone, n.connection, n.is_current]), [['77011112233', '', 0], ['77055556677', 'qr', 1]]);
  row = await db.prepare('SELECT state, pending_command FROM connector WHERE id = 1').first();
  assert.deepEqual([row.state, row.pending_command], ['open', '']);
  // managers cannot trigger it
  assert.equal((await mf.dispatchFetch(ORIGIN + '/api/wa-server/reload-history', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' })).status, 401);
});

test('legacy paths keep working: CONNECTOR_URL send for a QR number without a connector key, Cloud API send', { skip }, async () => {
  const seen = [];
  const mf2 = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
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

test('relink with instance ids: the command stays pending until acknowledged, goes only to the live instance, a stale copy cannot swallow it', { skip }, async () => {
  const st = (instance, body) => conn('POST', '/api/connector/state', Object.assign({ instance }, body));
  const ob = (instance) => conn('GET', '/api/connector/outbox?ready=0' + (instance ? '&instance=' + instance : ''));
  await st('aaaa1111', { state: 'open', phone: '77055556677' });
  assert.equal((await db.prepare('SELECT instance FROM connector WHERE id = 1').first()).instance, 'aaaa1111');
  assert.equal((await admin('POST', '/api/wa-server/reload-history', {})).status, 200);
  const cid = (await db.prepare('SELECT command_id FROM connector WHERE id = 1').first()).command_id;
  assert.match(cid, /^[0-9a-f]{12}$/);
  // the live instance is the last that posted: only it gets the command; a stale copy (another id) and a legacy copy (no id) do not
  assert.equal((await j(await ob('bbbb2222'))).command, null, 'another instance does not get it');
  assert.equal((await j(await ob(''))).command, null, 'a legacy connector does not swallow it while a newer one is alive');
  assert.equal((await db.prepare('SELECT pending_command FROM connector WHERE id = 1').first()).pending_command, 'relink', 'still pending');
  // handed out again and again until acknowledged
  for (let i = 0; i < 3; i++) {
    const o = await j(await ob('aaaa1111'));
    assert.deepEqual([o.command, o.commandId], ['relink', cid]);
  }
  // an acknowledgement with a wrong command id does not clear it
  await st('aaaa1111', { state: 'relinking', commandId: 'deadbeef' });
  assert.equal((await db.prepare('SELECT pending_command FROM connector WHERE id = 1').first()).pending_command, 'relink');
  // the right one does
  assert.equal((await st('aaaa1111', { state: 'relinking', commandId: cid })).status, 200);
  const row = await db.prepare('SELECT pending_command, state FROM connector WHERE id = 1').first();
  assert.deepEqual([row.pending_command, row.state], ['', 'relinking']);
  assert.equal((await j(await ob('aaaa1111'))).command, null);
  await st('aaaa1111', { state: 'logged_out' });
  await st('aaaa1111', { state: 'qr', qr: QR });
  assert.equal((await j(await admin('GET', '/api/wa-server'))).server.qr, QR);
});

test('relink: when the recorded instance is dead (silent for minutes) any new instance gets the command', { skip }, async () => {
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677', instance: 'aaaa1111' });
  assert.equal((await admin('POST', '/api/wa-server/relink', {})).status, 200);
  await db.prepare("UPDATE connector SET last_seen_at = ? WHERE id = 1").bind(new Date(Date.now() - 10 * 60000).toISOString()).run();
  const o = await j(await conn('GET', '/api/connector/outbox?ready=0&instance=cccc3333'));
  assert.equal(o.command, 'relink');
  // clean up: acknowledge and forget the instance, the other tests use connectors without ids
  await conn('POST', '/api/connector/state', { state: 'relinking', commandId: o.commandId, instance: 'cccc3333' });
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677', instance: 'cccc3333' });
});

test('state "replaced" is accepted and shown; a bad instance id is ignored', { skip }, async () => {
  assert.equal((await conn('POST', '/api/connector/state', { state: 'replaced', reason: 440, instance: 'cccc3333' })).status, 200);
  const sv = (await j(await admin('GET', '/api/wa-server'))).server;
  assert.equal(sv.state, 'replaced');
  await conn('POST', '/api/connector/state', { state: 'closed', instance: '<script>' });
  assert.equal((await db.prepare('SELECT instance FROM connector WHERE id = 1').first()).instance, 'cccc3333');
  await conn('POST', '/api/connector/state', { state: 'open', phone: '77055556677' });
  await db.prepare("UPDATE connector SET instance = '' WHERE id = 1").run();
});

test('the CRM page knows the «replaced» state in Russian', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /replaced: 'Программа запущена дважды — перезагрузите ноутбук'/);
});

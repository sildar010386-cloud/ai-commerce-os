// Promotions «1+1» / «2+1»: pure math (public/promo.js) and the Worker (create/update, stock, Kazpost, migration backfill) on miniflare.
// Run: node --test test/*.test.js   (the Worker part is skipped without miniflare)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../public/promo.js');

/* ---------- pure functions ---------- */
test('giftFor: 1+1 = paid, 2+1 = floor(paid / 2), none = 0', () => {
  assert.equal(P.giftFor('1+1', 3), 3);
  assert.equal(P.giftFor('2+1', 1), 0);
  assert.equal(P.giftFor('2+1', 2), 1);
  assert.equal(P.giftFor('2+1', 3), 1);
  assert.equal(P.giftFor('2+1', 4), 2);
  assert.equal(P.giftFor('', 5), 0);
  assert.equal(P.giftFor('bogus', 5), 0);
});

test('orderUnits / qtyLabel', () => {
  assert.deepEqual(P.orderUnits({ qty: 6, paidQty: 4, giftQty: 2 }), { paid: 4, gift: 2, total: 6 });
  assert.deepEqual(P.orderUnits({ qty: 3 }), { paid: 3, gift: 0, total: 3 }); // old server: all paid
  assert.equal(P.qtyLabel({ promo: '2+1', qty: 3, paidQty: 2, giftQty: 1 }), '3 шт. (2 + 1 в подарок)');
  assert.equal(P.qtyLabel({ promo: '', qty: 3, paidQty: 3, giftQty: 0 }), '');
});

const FIN = { p1: { buy: 1000, ship: 500, pack: 100, other: 50, feePct: 10 }, general: { fixedMonth: 30000 } };
test('calcProfit: per-unit costs x shipped (gifts included), per-parcel costs once per order, fee of the sum', () => {
  const orders = [
    { productId: 'p1', productName: 'Отпариватель', qty: 1, paidQty: 1, giftQty: 0, sum: 10000 },
    { productId: 'p1', productName: 'Отпариватель', promo: '2+1', qty: 6, paidQty: 4, giftQty: 2, sum: 40000 }
  ];
  const r = P.calcProfit(orders, FIN, 7);
  assert.equal(r.qty, 7);
  assert.equal(r.paidQty, 5);
  assert.equal(r.giftQty, 2);
  assert.equal(r.giftCost, 2000);
  assert.equal(r.rev, 50000);
  // per unit (buy + other) 1050 x 7 shipped + per parcel (ship + pack) 600 x 2 orders + 10% of 50000
  assert.equal(r.cost, 7 * 1050 + 2 * 600 + 5000);
  assert.ok(Math.abs(r.fixed - 7000) < 1e-9);
  assert.ok(Math.abs(r.net - (50000 - (7350 + 1200 + 5000) - 7000)) < 1e-9);
  assert.deepEqual(r.missing, []);
});

test('calcProfit: parcel costs do not grow with the quantity', () => {
  const f = { p1: { buy: 0, other: 0, ship: 700, pack: 100, feePct: 0 } };
  const one = P.calcProfit([{ productId: 'p1', qty: 1, sum: 0 }], f, 0);
  const five = P.calcProfit([{ productId: 'p1', qty: 5, sum: 0 }], f, 0);
  assert.equal(one.cost, 800); assert.equal(five.cost, 800);
});

test('extras: by type, unit lines x shipped units, parcel lines once', () => {
  const f = { p1: { buy: 1000, other: 0, ship: 500, pack: 0, feePct: 0, extras: [
    { name: 'Пакет', amount: 30, per: 'unit' }, { name: 'Скотч', amount: 20, per: 'parcel' }, { name: 'Курьер до почты', amount: 300, per: 'parcel' }
  ] } };
  assert.deepEqual(P.unitCosts(f.p1), { unit: 1030, parcel: 820, feePct: 0 });
  const r = P.calcProfit([{ productId: 'p1', qty: 3, paidQty: 2, giftQty: 1, promo: '2+1', sum: 20000 }], f, 0);
  assert.equal(r.cost, 3 * 1030 + 820);
  assert.equal(r.net, 20000 - 3910);
});

test('orderProfit: single order, 1+1 and 2+1 examples', () => {
  const f = { buy: 1000, other: 0, ship: 500, pack: 100, feePct: 10, extras: [] };
  const a = P.orderProfit(10000, f, '', 1);   // 10000 - 1000 - 600 - 1000
  assert.equal(a.profit, 7400); assert.equal(a.shipped, 1);
  const b = P.orderProfit(10000, f, '1+1', 1); // 2 shipped: 10000 - 2000 - 600 - 1000
  assert.equal(b.profit, 6400); assert.equal(b.shipped, 2); assert.equal(b.gift, 1);
  const c = P.orderProfit(10000, f, '2+1', 2); // revenue 20000, 3 shipped: 20000 - 3000 - 600 - 2000
  assert.equal(c.profit, 14400); assert.equal(c.shipped, 3);
});

test('calcProfit: product without finance is reported and its units/revenue still count', () => {
  const r = P.calcProfit([{ productId: 'zz', productName: 'Чехол', qty: 2, paidQty: 1, giftQty: 1, promo: '1+1', sum: 500 }], FIN, 1);
  assert.equal(r.qty, 2); assert.equal(r.giftQty, 1); assert.equal(r.rev, 500); assert.equal(r.cost, 0);
  assert.deepEqual(r.missing, ['Чехол']);
});

test('promoStats', () => {
  const r = P.promoStats([
    { promo: '1+1', qty: 2, paidQty: 1, giftQty: 1 }, { promo: '2+1', qty: 6, paidQty: 4, giftQty: 2 },
    { promo: '2+1', qty: 3, paidQty: 2, giftQty: 1 }, { promo: '', qty: 2, paidQty: 2, giftQty: 0 }
  ]);
  assert.deepEqual(r, { orders11: 1, orders21: 2, gift: 4, shipped: 13, paid: 9 });
});

/* ---------- Worker on miniflare ---------- */
const SRC = path.join(__dirname, '../src');
let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';
const ORIGIN = 'http://crm.test';
const KEY = 'test-api-key-0123456789';
let mf, db, cookie, mgrCookie, pid;

const applySql = async (d, file) => {
  const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
  for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await d.prepare(st).run();
};
const MIG = path.join(__dirname, '../migrations');
const api = (ck, method, p, body) => mf.dispatchFetch(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (m, p, b) => api(cookie, m, p, b);
const login = async (email, password) => {
  const r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const mk = async (body) => {
  const r = await admin('POST', '/api/orders', body);
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return (await r.json()).id;
};
const get = async (id) => (await (await admin('GET', '/api/orders')).json()).orders.find((o) => o.id === id);
const stock = async () => (await (await admin('GET', '/api/products')).json()).products.find((p) => p.id === pid).stock;
const shape = (o) => ({ promo: o.promo, paidQty: o.paidQty, giftQty: o.giftQty, qty: o.qty });

before(async () => {
  if (!Miniflare) return;
  const mods = ['wa.js', 'source.js', 'fx.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') }));
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'entry.js', contents: fs.readFileSync(path.join(SRC, 'worker.js'), 'utf8') }].concat(mods),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'promodb', OLD: 'olddb' }, bindings: { CRM_API_KEY: KEY }
  });
  db = await mf.getD1Database('DB');
  for (const f of fs.readdirSync(MIG).sort()) await applySql(db, path.join(MIG, f));
  let r = await mf.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.kz', name: 'Админ', password: 'long-password-123' }) });
  assert.equal(r.status, 201);
  cookie = await login('a@b.kz', 'long-password-123');
  r = await admin('POST', '/api/users', { email: 'm@b.kz', name: 'Менеджер', password: 'manager-pass-123' });
  assert.equal(r.status, 201);
  mgrCookie = await login('m@b.kz', 'manager-pass-123');
  r = await admin('POST', '/api/products', { name: 'Отпариватель', price: 10000, stock: 100 });
  pid = (await r.json()).id;
});
after(async () => { if (mf) await mf.dispose(); });

test('migration 0009 backfills existing rows: paid_qty = qty, gift_qty = 0, promo empty', { skip }, async () => {
  const old = await mf.getD1Database('OLD');
  for (const f of fs.readdirSync(MIG).sort().filter((x) => x < '0009')) await applySql(old, path.join(MIG, f));
  const ts = '2026-11-01T00:00:00.000Z';
  await old.prepare("INSERT INTO orders (num, status, name, qty, sum, created_at, updated_at) VALUES (1, 'new', 'A', 3, 100, ?, ?), (2, 'new', 'B', 1, 50, ?, ?)").bind(ts, ts, ts, ts).run();
  await applySql(old, path.join(MIG, '0009_promo.sql'));
  const { results } = await old.prepare('SELECT num, qty, promo, paid_qty, gift_qty FROM orders ORDER BY num').all();
  assert.deepEqual(results.map((r) => [r.num, r.qty, r.promo, r.paid_qty, r.gift_qty]), [[1, 3, '', 3, 0], [2, 1, '', 1, 0]]);
});

test('create without a promo: defaults promo "", paid 1, gift 0, qty 1; explicit qty means paid = qty', { skip }, async () => {
  assert.deepEqual(shape(await get(await mk({ name: 'Plain' }))), { promo: '', paidQty: 1, giftQty: 0, qty: 1 });
  assert.deepEqual(shape(await get(await mk({ name: 'Plain5', qty: 5 }))), { promo: '', paidQty: 5, giftQty: 0, qty: 5 });
  assert.deepEqual(shape(await get(await mk({ name: 'Plain5b', promo: '', paidQty: 4 }))), { promo: '', paidQty: 4, giftQty: 0, qty: 4 });
});

test('create 1+1: paid 2 -> gift 2, qty 4', { skip }, async () => {
  assert.deepEqual(shape(await get(await mk({ name: 'P11', promo: '1+1', paidQty: 2, sum: 20000 }))), { promo: '1+1', paidQty: 2, giftQty: 2, qty: 4 });
});

test('create 2+1: paid 1 -> 0 gift; paid 2 -> 1; paid 3 -> 1; paid 4 -> gift 2, qty 6', { skip }, async () => {
  const exp = { 1: [0, 1], 2: [1, 3], 3: [1, 4], 4: [2, 6] };
  for (const paid of [1, 2, 3, 4]) {
    const o = await get(await mk({ name: 'P21-' + paid, promo: '2+1', paidQty: paid }));
    assert.deepEqual(shape(o), { promo: '2+1', paidQty: paid, giftQty: exp[paid][0], qty: exp[paid][1] });
  }
});

test('a client qty that contradicts the promotion is ignored', { skip }, async () => {
  const o = await get(await mk({ name: 'Liar', promo: '2+1', paidQty: 4, qty: 99 }));
  assert.deepEqual(shape(o), { promo: '2+1', paidQty: 4, giftQty: 2, qty: 6 });
});

test('invalid promo / paidQty are rejected with 400 on create and update', { skip }, async () => {
  for (const bad of [{ promo: '3+1' }, { promo: '1 + 1' }, { promo: 5 }, { promo: '2+1', paidQty: 0 }, { promo: '1+1', paidQty: 'abc' }, { promo: '1+1', paidQty: 20000 }]) {
    const r = await admin('POST', '/api/orders', Object.assign({ name: 'Bad' }, bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const id = await mk({ name: 'Ok' });
  const r = await admin('PATCH', '/api/orders/' + id, { promo: 'xx' });
  assert.equal(r.status, 400);
  assert.deepEqual(shape(await get(id)), { promo: '', paidQty: 1, giftQty: 0, qty: 1 });
});

test('update: switching promo and paidQty recomputes gift and qty', { skip }, async () => {
  const id = await mk({ name: 'Upd', qty: 2 });
  assert.equal((await admin('PATCH', '/api/orders/' + id, { promo: '1+1' })).status, 200);
  assert.deepEqual(shape(await get(id)), { promo: '1+1', paidQty: 2, giftQty: 2, qty: 4 });
  await admin('PATCH', '/api/orders/' + id, { promo: '2+1', paidQty: 4 });
  assert.deepEqual(shape(await get(id)), { promo: '2+1', paidQty: 4, giftQty: 2, qty: 6 });
  await admin('PATCH', '/api/orders/' + id, { paidQty: 5 }); // promo stays
  assert.deepEqual(shape(await get(id)), { promo: '2+1', paidQty: 5, giftQty: 2, qty: 7 });
  await admin('PATCH', '/api/orders/' + id, { qty: 50 }); // contradicting qty with a promo is ignored
  assert.deepEqual(shape(await get(id)), { promo: '2+1', paidQty: 5, giftQty: 2, qty: 7 });
  await admin('PATCH', '/api/orders/' + id, { promo: '' }); // promo off: gifts disappear, paid stays
  assert.deepEqual(shape(await get(id)), { promo: '', paidQty: 5, giftQty: 0, qty: 5 });
  await admin('PATCH', '/api/orders/' + id, { qty: 3 }); // no promo: qty is edited directly, paid = qty
  assert.deepEqual(shape(await get(id)), { promo: '', paidQty: 3, giftQty: 0, qty: 3 });
  const hist = (await (await admin('GET', '/api/orders/' + id + '/audit')).json()).audit;
  assert.ok(hist.some((a) => a.action === 'edit' && /promo/.test(a.detail)), 'promo edits are audited');
});

test('manager can set and edit promos', { skip }, async () => {
  let r = await api(mgrCookie, 'POST', '/api/orders', { name: 'Mgr', promo: '2+1', paidQty: 2 });
  assert.equal(r.status, 201);
  const id = (await r.json()).id;
  r = await api(mgrCookie, 'PATCH', '/api/orders/' + id, { promo: '1+1', paidQty: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(shape(await get(id)), { promo: '1+1', paidQty: 3, giftQty: 3, qty: 6 });
});

test('stock decreases by TOTAL qty on status -> sent, exactly once', { skip }, async () => {
  const before = await stock();
  const id = await mk({ name: 'Stock', phone: '+77010000001', productId: pid, promo: '2+1', paidQty: 4 });
  assert.equal(await stock(), before); // not shipped yet
  const r = await admin('PATCH', '/api/orders/' + id, { status: 'sent', delivery: 'Казпочта', track: 'UU000000011KZ' });
  assert.equal(r.status, 200);
  assert.equal(await stock(), before - 6);
  await admin('PATCH', '/api/orders/' + id, { status: 'done' });
  await admin('PATCH', '/api/orders/' + id, { status: 'sent' });
  await admin('PATCH', '/api/orders/' + id, { comment: 'again' });
  assert.equal(await stock(), before - 6, 'deducted only once');
});

test('order created directly as «sent» with 1+1 deducts paid + gift once', { skip }, async () => {
  const before = await stock();
  await mk({ name: 'Direct', productId: pid, promo: '1+1', paidQty: 2, status: 'sent', delivery: 'Курьер' });
  assert.equal(await stock(), before - 4);
});

test('Kazpost apply deducts the TOTAL qty exactly once', { skip }, async () => {
  const before = await stock();
  const id = await mk({ name: 'Kaz', phone: '+77010000002', productId: pid, promo: '2+1', paidQty: 4 });
  const body = { pairs: [{ orderId: id, track: 'UU000000024KZ' }] };
  let r = await admin('POST', '/api/kazpost/apply', body);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.sent, 1, JSON.stringify(d));
  assert.equal(await stock(), before - 6);
  r = await admin('POST', '/api/kazpost/apply', body); // repeat: already sent
  assert.equal((await r.json()).already, 1);
  assert.equal(await stock(), before - 6);
  assert.equal((await get(id)).status, 'sent');
});

const putFin = (ck, key, body) => api(ck, 'PUT', '/api/finance/' + key, body);
test('finance: extras are validated and saved; a save without extras keeps them; managers cannot read or write costs', { skip }, async () => {
  const ok = [{ name: 'Пакет', amount: 30, per: 'unit' }, { name: 'Скотч', amount: '20,5', per: 'parcel' }];
  let r = await putFin(cookie, pid, { buy: 1000, ship: 500, pack: 100, feePct: 5, other: 10, extras: ok });
  assert.equal(r.status, 200);
  let fin = (await (await admin('GET', '/api/finance')).json()).finance[pid];
  assert.deepEqual(fin.extras, [{ name: 'Пакет', amount: 30, per: 'unit' }, { name: 'Скотч', amount: 20.5, per: 'parcel' }]);
  assert.equal(fin.ship, 500);
  r = await putFin(cookie, pid, { buy: 1100, ship: 500, pack: 100, feePct: 5, other: 10 });
  assert.equal(r.status, 200);
  fin = (await (await admin('GET', '/api/finance')).json()).finance[pid];
  assert.equal(fin.buy, 1100); assert.equal(fin.extras.length, 2);
  const bad = [
    [{ name: '', amount: 1, per: 'unit' }], [{ name: 'x'.repeat(41), amount: 1, per: 'unit' }], [{ name: 'a', amount: -1, per: 'unit' }],
    [{ name: 'a', amount: 1e8, per: 'unit' }], [{ name: 'a', amount: 1, per: 'order' }], [{ name: 'a', amount: 1 }], 'text',
    Array.from({ length: 21 }, (_, i) => ({ name: 'n' + i, amount: 1, per: 'unit' }))
  ];
  for (const extras of bad) assert.equal((await putFin(cookie, pid, { buy: 1, extras })).status, 400, JSON.stringify(extras).slice(0, 60));
  r = await putFin(cookie, pid, { buy: 1, extras: Array.from({ length: 20 }, (_, i) => ({ name: 'n' + i, amount: 1, per: 'parcel' })) });
  assert.equal(r.status, 200);
  r = await putFin(cookie, pid, { buy: 1, extras: [] });
  assert.equal((await (await admin('GET', '/api/finance')).json()).finance[pid].extras.length, 0);
  assert.equal((await api(mgrCookie, 'GET', '/api/finance')).status, 403);
  assert.equal((await putFin(mgrCookie, pid, { buy: 1 })).status, 403);
});

// Advertising costs, USD->KZT, repeat customers, upsell lines: pure math (public/promo.js, src/fx.js) + the Worker on miniflare.
// Run: node --test test/*.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../public/promo.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/* ---------- FX parsers ---------- */
const NBK_XML = `<?xml version="1.0" encoding="utf-8"?>
<rates>
<generator>nationalbank.kz</generator>
<title>Official exchange rates</title>
<link>https://nationalbank.kz</link>
<description>Official exchange rates</description>
<copyright>Copyright National Bank of Kazakhstan</copyright>
<item><fullname>ДОЛЛАР США</fullname><title>USD</title><description>470.94</description><quant>1</quant><index>DOWN</index><change>-0.10</change><link>https://nationalbank.kz/</link></item>
<item><fullname>ЕВРО</fullname><title>EUR</title><description>548.12</description><quant>1</quant></item>
<item><fullname>ЯПОНСКАЯ ЙЕНА</fullname><title>JPY</title><description>310.50</description><quant>100</quant></item>
</rates>`;
const NBK_XML_QUANT = '<rates><item><title>EUR</title><description>1</description><quant>1</quant></item><item><title> usd </title><description><![CDATA[ 2354,70 ]]></description><quant>5</quant></item></rates>';
const ERAPI_JSON = '{"result":"success","provider":"https://www.exchangerate-api.com","base_code":"USD","rates":{"USD":1,"EUR":0.92,"KZT":512.3,"RUB":90.1}}';
let fx;
before(async () => { fx = await import(pathToFileURL(path.join(__dirname, '../src/fx.js')).href); });

test('parseNbkUsd: finds USD among items, value / quant', () => {
  assert.equal(fx.parseNbkUsd(NBK_XML), 470.94);
  near(fx.parseNbkUsd(NBK_XML_QUANT), 470.94); // 2354.70 / 5, comma, CDATA, lower case with spaces
  assert.equal(fx.parseNbkUsd('<rates><item><title>EUR</title><description>1</description></item></rates>'), null);
  assert.equal(fx.parseNbkUsd(''), null);
  assert.equal(fx.parseNbkUsd(null), null);
  assert.equal(fx.parseNbkUsd('<rates><item><title>USD</title><description>abc</description></item></rates>'), null);
  assert.equal(fx.parseNbkUsd('<html>Service unavailable</html>'), null);
});
test('parseErApiUsd: rates.KZT or null', () => {
  assert.equal(fx.parseErApiUsd(ERAPI_JSON), 512.3);
  assert.equal(fx.parseErApiUsd(JSON.parse(ERAPI_JSON)), 512.3);
  assert.equal(fx.parseErApiUsd('{"result":"error"}'), null);
  assert.equal(fx.parseErApiUsd('{"result":"success","rates":{"EUR":1}}'), null);
  assert.equal(fx.parseErApiUsd('not json'), null);
});
test('fetchNbkUsd / fetchErApiUsd: mocked fetch, DD.MM.YYYY url, failures give null', async () => {
  let seen = '';
  const ok = async (u) => { seen = u; return new Response(NBK_XML, { status: 200 }); };
  assert.equal(await fx.fetchNbkUsd('2026-11-05', ok), 470.94);
  assert.equal(seen, 'https://nationalbank.kz/rss/get_rates.cfm?fdate=05.11.2026');
  assert.equal(await fx.fetchNbkUsd('2026-11-05', async () => new Response('x', { status: 500 })), null);
  assert.equal(await fx.fetchNbkUsd('2026-11-05', async () => { throw new Error('down'); }), null);
  assert.equal(await fx.fetchNbkUsd('bad', ok), null);
  assert.equal(await fx.fetchErApiUsd(async () => new Response(ERAPI_JSON, { status: 200 })), 512.3);
  assert.equal(await fx.fetchErApiUsd(async () => { throw new Error('down'); }), null);
});

/* ---------- economics: hand-computed example ---------- */
const FIN = { p1: { buy: 1000, ship: 500, pack: 100, other: 0, feePct: 10 }, p2: { buy: 200, other: 50 }, general: { fixedMonth: 30000 } };
const PRODUCTS = [{ id: 'p1', name: 'Отпариватель' }, { id: 'p2', name: 'Псодерм' }];

test('orderCalc: upsell order is ONE parcel, item units use ITS product costs', () => {
  const o = { status: 'paid', productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000, items: [{ productId: 'p2', productName: 'Псодерм', qty: 2, sum: 3000 }] };
  const r = P.orderCalc(o, FIN);
  // revenue = 10000 + 3000 = 13000
  // cost = main unit 1000 + parcel (500 + 100) + fee 10% of 13000 = 1300 + item 2 x (200 + 50) = 500 -> 1000 + 600 + 1300 + 500 = 3400
  assert.equal(r.rev, 13000);
  assert.equal(r.cost, 3400);
  assert.equal(r.itemQty, 2); assert.equal(r.itemRev, 3000);
  assert.deepEqual(r.missing, []);
  // calcProfit agrees (rev - cost = 9600) and counts main units only in qty
  const c = P.calcProfit([o], FIN, 0);
  assert.equal(c.net, 9600); assert.equal(c.qty, 1); assert.equal(c.itemQty, 2);
  // item product without finance -> reported, its units cost nothing
  const m = P.orderCalc(Object.assign({}, o, { items: [{ productId: 'zz', productName: 'Чехол', qty: 1, sum: 100 }] }), FIN);
  assert.deepEqual(m.missing, ['Чехол']); assert.equal(m.cost, 1000 + 600 + 0.1 * 10100);
  assert.deepEqual(P.upsellStats([o, { items: [] }, { productId: 'p1' }]), { orders: 1, units: 2, rev: 3000 });
  assert.equal(P.orderTotal(o), 13000);
});

test('economics: groups Таргет / Органика / Повторные, CPL, CPO, profit after ads (hand-computed)', () => {
  const orders = [
    { status: 'paid', traffic: 'target', productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000 },               // A: 10000 - (1000 + 600 + 1000) = 7400
    { status: 'sent', traffic: 'target', productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000 },               // B: 7400
    { status: 'done', traffic: 'target', isRepeat: true, productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000 }, // C: repeat, 7400
    { status: 'paid', traffic: 'organic', productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000, items: [{ productId: 'p2', productName: 'Псодерм', qty: 2, sum: 3000 }] }, // D: 13000 - 3400 = 9600
    { status: 'new', traffic: 'organic', productId: 'p1', productName: 'Отпариватель', qty: 1, sum: 10000 },               // E: not paid, ignored
    { status: 'paid', traffic: 'target', productId: 'p2', productName: 'Псодерм', qty: 1, sum: 5000 }                      // F: 5000 - 200 - 50 = 4750
  ];
  const e = P.economics({
    orders, products: PRODUCTS, finance: FIN, days: 7,
    spend: [{ productId: 'p1', amountKzt: 3000 }, { productId: 'p1', amountKzt: 2000 }, { productId: 'p2', amountKzt: 1000 }], // ad: p1 5000, p2 1000, total 6000
    targets: [{ code: 'A3', productId: 'p1', productName: '' }, { code: 'B7', productId: '', productName: 'псодерм' }],
    leads: [{ code: 'A3', productName: '', n: 10 }, { code: 'b7', productName: '', n: 5 }, { code: '', productName: 'Отпариватель', n: 2 }] // p1: 10 + 2 = 12, p2: 5 (by name)
  });
  // Таргет: A + B + F = 3 orders, revenue 25000, cost 2600 + 2600 + 250 = 5450, profit 19550, minus all ads 6000 = 13550
  assert.deepEqual([e.groups.target.orders, e.groups.target.rev, e.groups.target.cost, e.groups.target.profit], [3, 25000, 5450, 19550]);
  assert.equal(e.groups.target.profitAfterAds, 13550);
  // Органика: D = 1 order, revenue 13000, cost 3400, profit 9600
  assert.deepEqual([e.groups.organic.orders, e.groups.organic.rev, e.groups.organic.cost, e.groups.organic.profit], [1, 13000, 3400, 9600]);
  // Повторные: C = 1 order, revenue 10000, cost 2600, profit 7400 (a repeat target order is NOT counted in Таргет)
  assert.deepEqual([e.groups.repeat.orders, e.groups.repeat.rev, e.groups.repeat.cost, e.groups.repeat.profit], [1, 10000, 2600, 7400]);
  // totals: revenue 25000 + 13000 + 10000 = 48000, cost 5450 + 3400 + 2600 = 11450, ads 6000, fixed 30000 x 7 / 30 = 7000
  // net = 48000 - 11450 - 6000 - 7000 = 23550
  assert.equal(e.rev, 48000); assert.equal(e.cost, 11450); assert.equal(e.adSpend, 6000); near(e.fixed, 7000); near(e.net, 23550);
  // leads 17, CPL 6000 / 17, paid target orders 3, CPO 6000 / 3 = 2000
  assert.equal(e.leads, 17); near(e.cpl, 6000 / 17); assert.equal(e.paidTargetOrders, 3); assert.equal(e.cpo, 2000);
  const p1 = e.products.find((r) => r.productId === 'p1'), p2 = e.products.find((r) => r.productId === 'p2');
  // p1: ad 5000, leads 12 -> CPL 5000 / 12, target orders A + B = 2 -> CPO 2500, profit 7400 + 7400 = 14800, after ads 9800
  assert.deepEqual([p1.adSpend, p1.leads, p1.paidOrders, p1.cpo, p1.profit, p1.profitAfterAds], [5000, 12, 2, 2500, 14800, 9800]);
  near(p1.cpl, 5000 / 12);
  // p2: ad 1000, leads 5 -> CPL 200, target order F = 1 -> CPO 1000, profit 4750, after ads 3750
  assert.deepEqual([p2.adSpend, p2.leads, p2.cpl, p2.paidOrders, p2.cpo, p2.profit, p2.profitAfterAds], [1000, 5, 200, 1, 1000, 4750, 3750]);
  assert.equal(p1.profitAfterAds + p2.profitAfterAds, e.groups.target.profitAfterAds);
  assert.deepEqual(e.missing, []);
});

test('economics: nothing sold -> CPL / CPO are null, ad spend without leads still shows', () => {
  const e = P.economics({ orders: [], products: PRODUCTS, finance: FIN, days: 1, spend: [{ productId: 'p1', amountKzt: 700 }], leads: [], targets: [] });
  assert.equal(e.cpl, null); assert.equal(e.cpo, null);
  assert.equal(e.products.length, 1); assert.equal(e.products[0].cpl, null); assert.equal(e.products[0].profitAfterAds, -700);
  near(e.net, -700 - 1000);
});

/* ---------- Worker on miniflare ---------- */
const SRC = path.join(__dirname, '../src');
let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';
const ORIGIN = 'http://crm.test';
const KEY = 'test-api-key-0123456789';
const MIG = path.join(__dirname, '../migrations');
let mf, db, cookie, mgrCookie, p1, p2, outbound;
const calls = [];

const applySql = async (d, file) => {
  const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
  for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await d.prepare(st).run();
};
const api = (ck, method, p, body) => mf.dispatchFetch(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (m, p, b) => api(cookie, m, p, b);
const jget = async (p) => (await admin('GET', p)).json();
const login = async (email, password) => {
  const r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const day = (n) => new Date(Date.now() + 5 * 3600000 + n * 86400000).toISOString().slice(0, 10); // Almaty day, n days from today
const nbkXml = (rate) => `<rates><item><title>USD</title><description>${rate}</description><quant>1</quant></item></rates>`;
// NBK mock: rate = 500 + day of the month (so every date has its own rate); er-api: 600.
const defaultOutbound = async (req) => {
  const u = new URL(req.url);
  calls.push(u.host);
  if (u.host === 'nationalbank.kz') { const d = parseInt(u.searchParams.get('fdate').slice(0, 2), 10); return new Response(nbkXml(500 + d), { status: 200 }); }
  if (u.host === 'open.er-api.com') return new Response(ERAPI_JSON.replace('512.3', '600'), { status: 200 });
  return new Response('no', { status: 404 });
};
const mkOrder = async (body) => {
  const r = await admin('POST', '/api/orders', body);
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return String((await r.json()).id);
};
const orderOf = async (id) => (await jget('/api/orders')).orders.find((o) => o.id === id);
const stockOf = async (pid) => (await jget('/api/products')).products.find((p) => p.id === pid).stock;
const spendRows = async (from, to) => (await jget(`/api/ads/spend?from=${from}&to=${to}`)).spend;

before(async () => {
  if (!Miniflare) return;
  const mods = ['wa.js', 'source.js', 'fx.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') }));
  outbound = defaultOutbound;
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'entry.js', contents: fs.readFileSync(path.join(SRC, 'worker.js'), 'utf8') }].concat(mods),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'adsdb', OLD: 'oldadsdb' }, bindings: { CRM_API_KEY: KEY },
    outboundService: (req) => outbound(req)
  });
  db = await mf.getD1Database('DB');
  for (const f of fs.readdirSync(MIG).sort()) await applySql(db, path.join(MIG, f));
  let r = await mf.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.kz', name: 'Админ', password: 'long-password-123' }) });
  assert.equal(r.status, 201);
  cookie = await login('a@b.kz', 'long-password-123');
  r = await admin('POST', '/api/users', { email: 'm@b.kz', name: 'Менеджер', password: 'manager-pass-123' });
  assert.equal(r.status, 201);
  mgrCookie = await login('m@b.kz', 'manager-pass-123');
  p1 = (await (await admin('POST', '/api/products', { name: 'Отпариватель', price: 10000, stock: 100 })).json()).id;
  p2 = (await (await admin('POST', '/api/products', { name: 'Псодерм', price: 2500, stock: 50 })).json()).id;
});
after(async () => { if (mf) await mf.dispose(); });

test('USD campaign started in the past: one auto row per day to today, converted with each day NBK rate', { skip }, async () => {
  const r = await admin('POST', '/api/ads/campaigns', { productId: p1, label: 'Кабинет 3', currency: 'USD', dailyAmount: 50, startDate: day(-4) });
  assert.equal(r.status, 201);
  const rows = (await spendRows(day(-4), day(0))).filter((x) => x.campaignId === 1);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((x) => x.date), [-4, -3, -2, -1, 0].map(day));
  for (const x of rows) {
    const rate = 500 + parseInt(x.date.slice(8), 10);
    assert.equal(x.rate, rate); assert.equal(x.amountOrig, 50); assert.equal(x.currency, 'USD'); assert.equal(x.source, 'auto');
    assert.equal(x.amountKzt, 50 * rate); // e.g. day 05 -> 50 x 505 = 25250
  }
  const { results } = await db.prepare('SELECT date, usd_kzt, source FROM fx_rates ORDER BY date').all();
  assert.equal(results.length, 5); assert.ok(results.every((x) => x.source === 'nbk'));
});

test('accrual is idempotent and cheap: a second read inserts nothing and makes no NBK calls', { skip }, async () => {
  const before = calls.length;
  const n1 = (await db.prepare('SELECT COUNT(*) AS n FROM ad_spend').first()).n;
  await jget('/api/ads/campaigns'); await spendRows(day(-4), day(0));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ad_spend').first()).n, n1);
  assert.equal(calls.length, before);
});

test('KZT campaign: rate 1, amount = daily; GET /api/fx reports today NBK rate', { skip }, async () => {
  const r = await admin('POST', '/api/ads/campaigns', { productId: p2, label: 'KZT', currency: 'KZT', dailyAmount: 20000, startDate: day(-1) });
  assert.equal(r.status, 201);
  const rows = (await spendRows(day(-1), day(0))).filter((x) => x.campaignId === 2);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.rate === 1 && x.amountKzt === 20000 && x.currency === 'KZT'));
  const f = await jget('/api/fx');
  assert.equal(f.date, day(0)); assert.equal(f.rate, 500 + parseInt(day(0).slice(8), 10)); assert.equal(f.source, 'nbk'); assert.equal(f.manual, false);
});

test('manual override: recomputed with that day rate, survives re-accrual (campaign edit, scheduled cron)', { skip }, async () => {
  const d = day(-2);
  let r = await admin('PUT', `/api/ads/spend/1/${d}`, { amount_orig: 80 });
  assert.equal(r.status, 200);
  const rate = 500 + parseInt(d.slice(8), 10);
  let row = (await spendRows(d, d)).find((x) => x.campaignId === 1);
  assert.deepEqual([row.amountOrig, row.source, row.rate, row.amountKzt], [80, 'manual', rate, 80 * rate]);
  assert.equal((await admin('PATCH', '/api/ads/campaigns/1', { dailyAmount: 60 })).status, 200); // force re-accrual
  await (await mf.getWorker()).scheduled({ cron: '*/5 4-15 * * *' });
  row = (await spendRows(d, d)).find((x) => x.campaignId === 1);
  assert.deepEqual([row.amountOrig, row.source], [80, 'manual']);
  assert.equal((await spendRows(day(-1), day(-1))).find((x) => x.campaignId === 1).amountOrig, 50); // old auto days keep the old amount
  await admin('PATCH', '/api/ads/campaigns/1', { dailyAmount: 50 });
  assert.equal((await admin('PUT', `/api/ads/spend/1/${day(1)}`, { amount_orig: 5 })).status, 400); // future day
  assert.equal((await admin('PUT', `/api/ads/spend/1/${d}`, { amount_orig: -5 })).status, 400);
  assert.equal((await admin('PUT', `/api/ads/spend/99/${d}`, { amount_orig: 5 })).status, 404);
});

test('scheduled() cron accrues a campaign created straight in the database', { skip }, async () => {
  const ts = new Date().toISOString();
  await db.prepare("INSERT INTO ad_campaigns (id, product_id, label, currency, daily_amount, start_date, end_date, active, created_at, updated_at) VALUES (7, ?, 'cron', 'KZT', 1000, ?, '', 1, ?, ?)").bind(p1, day(-2), ts, ts).run();
  await db.prepare("DELETE FROM settings WHERE key = 'ads_accrued_on'").run();
  await (await mf.getWorker()).scheduled({ cron: '*/5 4-15 * * *' });
  const rows = (await spendRows(day(-2), day(0))).filter((x) => x.campaignId === 7);
  assert.deepEqual(rows.map((x) => x.amountKzt), [1000, 1000, 1000]);
  await admin('DELETE', '/api/ads/campaigns/7');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ad_spend WHERE campaign_id = 7').first()).n, 0);
});

test('deactivation: end_date = today, today row stays, nothing is accrued after it; reactivation fills the stopped days with 0', { skip }, async () => {
  const r = await admin('POST', '/api/ads/campaigns', { productId: p1, label: 'Stop', currency: 'KZT', dailyAmount: 1000, startDate: day(-5) });
  const id = (await r.json()).id;
  assert.equal((await spendRows(day(-5), day(0))).filter((x) => x.campaignId === id).length, 6);
  await admin('PATCH', `/api/ads/campaigns/${id}`, { active: false });
  let c = (await jget('/api/ads/campaigns')).campaigns.find((x) => x.id === id);
  assert.equal(c.active, false); assert.equal(c.endDate, day(0));
  assert.equal((await spendRows(day(-5), day(0))).filter((x) => x.campaignId === id).length, 6); // today's row stays
  // simulate: stopped 3 days ago (rows after it removed), then switched on again
  await db.prepare('UPDATE ad_campaigns SET end_date = ? WHERE id = ?').bind(day(-3), id).run();
  await db.prepare('DELETE FROM ad_spend WHERE campaign_id = ? AND date > ?').bind(id, day(-3)).run();
  await db.prepare("DELETE FROM settings WHERE key = 'ads_accrued_on'").run();
  const stopped = (await spendRows(day(-5), day(0))).filter((x) => x.campaignId === id);
  assert.deepEqual(stopped.map((x) => x.date), [day(-5), day(-4), day(-3)]); // inactive campaign accrues nothing new
  await admin('PATCH', `/api/ads/campaigns/${id}`, { active: true });
  c = (await jget('/api/ads/campaigns')).campaigns.find((x) => x.id === id);
  assert.equal(c.active, true); assert.equal(c.endDate, '');
  const rows = (await spendRows(day(-5), day(0))).filter((x) => x.campaignId === id);
  assert.deepEqual(rows.map((x) => x.amountKzt), [1000, 1000, 1000, 0, 0, 1000]); // -2 and -1 days were stopped (0), today runs
  // an explicit end date stops accrual too
  const r2 = await admin('POST', '/api/ads/campaigns', { productId: p1, label: 'Ended', currency: 'KZT', dailyAmount: 10, startDate: day(-5), endDate: day(-3) });
  const id2 = (await r2.json()).id;
  assert.equal((await spendRows(day(-5), day(0))).filter((x) => x.campaignId === id2).length, 3);
  assert.equal((await admin('POST', '/api/ads/campaigns', { productId: p1, startDate: day(-1), endDate: day(-3) })).status, 400);
  await admin('DELETE', `/api/ads/campaigns/${id}`); await admin('DELETE', `/api/ads/campaigns/${id2}`);
});

test('FX fallbacks: manual setting > cached row > NBK > er-api > latest known row; failures never break the page', { skip }, async () => {
  const today = day(0);
  // NBK down, er-api up: today's rate = er-api 600, stored as erapi
  await db.prepare('DELETE FROM fx_rates').run();
  outbound = async (req) => (new URL(req.url).host === 'open.er-api.com' ? defaultOutbound(req) : new Response('down', { status: 503 }));
  let f = await jget('/api/fx');
  assert.deepEqual([f.rate, f.source], [600, 'erapi']);
  assert.equal((await db.prepare('SELECT source FROM fx_rates WHERE date = ?').bind(today).first()).source, 'erapi');
  // everything down but a known row exists: latest known row
  await db.prepare('DELETE FROM fx_rates').run();
  await db.prepare("INSERT INTO fx_rates (date, usd_kzt, source, fetched_at) VALUES (?, 480.5, 'nbk', 'x')").bind(day(-20)).run();
  outbound = async () => { throw new Error('offline'); };
  f = await jget('/api/fx');
  assert.deepEqual([f.rate, f.source], [480.5, 'last']);
  // nothing at all: rate null, still 200
  await db.prepare('DELETE FROM fx_rates').run();
  const r = await admin('GET', '/api/fx'); assert.equal(r.status, 200);
  assert.equal((await r.json()).rate, null);
  // no rate: a USD campaign is not charged yet (and the page works); the days appear once a rate is known
  const cr = await admin('POST', '/api/ads/campaigns', { productId: p1, label: 'NoRate', currency: 'USD', dailyAmount: 10, startDate: day(-1) });
  assert.equal(cr.status, 201);
  const id = (await cr.json()).id;
  assert.equal((await spendRows(day(-1), day(0))).filter((x) => x.campaignId === id).length, 0);
  // manual setting wins over everything and is not stored in fx_rates
  assert.equal((await admin('PUT', '/api/settings', { usd_manual: '500' })).status, 200);
  f = await jget('/api/fx');
  assert.deepEqual([f.rate, f.source, f.manual], [500, 'manual', true]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fx_rates').first()).n, 0);
  await admin('PATCH', `/api/ads/campaigns/${id}`, { label: 'NoRate2' }); // force accrual
  const rows = (await spendRows(day(-1), day(0))).filter((x) => x.campaignId === id);
  assert.deepEqual(rows.map((x) => [x.rate, x.amountKzt]), [[500, 5000], [500, 5000]]);
  assert.equal((await admin('PUT', '/api/settings', { usd_manual: 'abc' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { usd_manual: '' })).status, 200);
  outbound = defaultOutbound;
  f = await jget('/api/fx');
  assert.equal(f.source, 'nbk');
  await admin('DELETE', `/api/ads/campaigns/${id}`);
});

test('manual rate 500 on a USD 50/day campaign: 25000 per day', { skip }, async () => {
  await admin('PUT', '/api/settings', { usd_manual: '500' });
  const r = await admin('POST', '/api/ads/campaigns', { productId: p2, label: 'Manual500', currency: 'USD', dailyAmount: 50, startDate: day(-4) });
  const id = (await r.json()).id;
  const rows = (await spendRows(day(-4), day(0))).filter((x) => x.campaignId === id);
  assert.equal(rows.length, 5); assert.ok(rows.every((x) => x.amountKzt === 25000 && x.rate === 500));
  await admin('PUT', '/api/settings', { usd_manual: '' });
  await admin('DELETE', `/api/ads/campaigns/${id}`);
});

test('no rate at first (all sources down, page already opened today), manual rate set later: the waiting USD days are accrued, a manual day is kept', { skip }, async () => {
  await db.prepare('DELETE FROM fx_rates').run();
  outbound = async () => new Response('down', { status: 503 });
  await jget('/api/ads/campaigns');                              // a read today marks the day as done before the campaign exists
  const r = await admin('POST', '/api/ads/campaigns', { productId: p2, label: 'NoRate', currency: 'USD', dailyAmount: 50, startDate: day(-2) });
  const id = (await r.json()).id;
  assert.equal((await spendRows(day(-2), day(0))).filter((x) => x.campaignId === id).length, 0);   // nothing without a rate
  assert.equal((await admin('PUT', `/api/ads/spend/${id}/${day(0)}`, { amountOrig: 40 })).status >= 400, true); // no rate for a manual day either
  await admin('PUT', '/api/settings', { usd_manual: '500' });     // the owner types the rate
  const rows = (await spendRows(day(-2), day(0))).filter((x) => x.campaignId === id);
  assert.deepEqual(rows.map((x) => x.date), [-2, -1, 0].map(day));
  assert.ok(rows.every((x) => x.amountKzt === 25000 && x.source === 'auto'));  // 50 $ x 500 = 25000 a day
  assert.equal((await admin('PUT', `/api/ads/spend/${id}/${day(-1)}`, { amountOrig: 40 })).status, 200);
  await db.prepare("DELETE FROM ad_spend WHERE campaign_id = ? AND date = ?").bind(id, day(-2)).run(); // a gap BEFORE a manual day
  await db.prepare("DELETE FROM settings WHERE key = 'ads_accrued_on'").run();
  const again = (await spendRows(day(-2), day(0))).filter((x) => x.campaignId === id);
  assert.deepEqual(again.map((x) => [x.date, x.amountKzt, x.source]), [[day(-2), 25000, 'auto'], [day(-1), 20000, 'manual'], [day(0), 25000, 'auto']]);
  outbound = defaultOutbound;
  await admin('PUT', '/api/settings', { usd_manual: '' });
  await admin('DELETE', `/api/ads/campaigns/${id}`);
});

test('campaign validation', { skip }, async () => {
  for (const bad of [{ currency: 'EUR' }, { dailyAmount: -1 }, { productId: 'nope' }, { startDate: '2026-13-40' }, { label: 'x'.repeat(61) }]) {
    const r = await admin('POST', '/api/ads/campaigns', Object.assign({ productId: p1, currency: 'USD', dailyAmount: 1 }, bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin('POST', '/api/ads/campaigns', { currency: 'USD', dailyAmount: 1 })).status, 400);
  assert.equal((await admin('PATCH', '/api/ads/campaigns/999', { label: 'x' })).status, 404);
  assert.equal((await admin('GET', '/api/ads/spend?from=2026-01-01&to=2027-12-31')).status, 400);
});

test('admin only: a manager gets 403 on every ads / fx endpoint and does not see usd_manual', { skip }, async () => {
  for (const [m, p, b] of [['GET', '/api/ads/campaigns'], ['POST', '/api/ads/campaigns', { productId: p1 }], ['PATCH', '/api/ads/campaigns/1', { label: 'x' }], ['DELETE', '/api/ads/campaigns/1'],
    ['GET', '/api/ads/spend'], ['PUT', `/api/ads/spend/1/${day(0)}`, { amount_orig: 1 }], ['GET', '/api/ads/leads'], ['GET', '/api/fx'], ['PUT', '/api/settings', { usd_manual: '1' }], ['GET', '/api/finance']]) {
    const r = await api(mgrCookie, m, p, b);
    assert.equal(r.status, 403, m + ' ' + p);
  }
  const s = (await (await api(mgrCookie, 'GET', '/api/settings')).json()).settings;
  assert.ok(!('usd_manual' in s));
  const anon = await mf.dispatchFetch(ORIGIN + '/api/ads/campaigns');
  assert.equal(anon.status, 401);
  assert.equal((await api(mgrCookie, 'GET', '/api/orders')).status, 200); // managers still see orders
  const o = (await (await api(mgrCookie, 'GET', '/api/orders')).json()).orders;
  assert.ok(o.every((x) => !('adSpend' in x)));
});

test('leads: target contacts grouped by code, Almaty day boundaries', { skip }, async () => {
  const ins = (ext, traffic, code, pname, first) => db.prepare("INSERT INTO contacts (channel, ext_id, phone, traffic, target_code, product_name, first_message_at, created_at, updated_at) VALUES ('whatsapp', ?, ?, ?, ?, ?, ?, 'x', 'x')").bind(ext, ext, traffic, code, pname, first).run();
  const d = day(-3); // Almaty day D: from D-1T19:00Z (00:00 +05) to DT18:59Z
  const prev = day(-4);
  await ins('l1', 'target', 'A3', 'Отпариватель', `${d}T00:30:00.000Z`);      // 05:30 on D -> D
  await ins('l2', 'target', 'A3', 'Отпариватель', `${prev}T19:30:00.000Z`);    // 00:30 on D (UTC previous day) -> D
  await ins('l3', 'target', 'A3', 'Отпариватель', `${d}T19:30:00.000Z`);       // 00:30 on D+1 -> NOT in D
  await ins('l4', 'organic', '', '', `${d}T05:00:00.000Z`);                    // organic -> never a lead
  await ins('l5', 'target', 'B7', 'Псодерм', `${d}T10:00:00.000Z`);
  await ins('l6', 'target', 'A3', 'Отпариватель', '');                         // no first message time -> ignored
  const r = await jget(`/api/ads/leads?from=${d}&to=${d}`);
  const m = {}; r.leads.forEach((x) => { m[x.code] = x.n; });
  assert.deepEqual(m, { A3: 2, B7: 1 });
});

test('target texts link to products: productId is checked, name follows the product, back-compat free name', { skip }, async () => {
  let r = await admin('POST', '/api/targets', { productId: p1, code: 'T1', text: 'Хочу отпариватель (T1)' });
  assert.equal(r.status, 201);
  const list = async () => (await jget('/api/targets')).targets;
  let t = (await list()).find((x) => x.code === 'T1');
  assert.deepEqual([t.productId, t.productName], [p1, 'Отпариватель']);
  assert.equal((await admin('POST', '/api/targets', { productId: 'nope', code: 'T2', text: 'x' })).status, 400);
  r = await admin('POST', '/api/targets', { productName: 'Свободный текст', code: 'T3', text: 'y (T3)' });
  assert.equal(r.status, 201);
  t = (await list()).find((x) => x.code === 'T3');
  assert.deepEqual([t.productId, t.productName], ['', 'Свободный текст']);
  assert.equal((await admin('PATCH', `/api/targets/${t.id}`, { productId: p2 })).status, 200);
  t = (await list()).find((x) => x.code === 'T3');
  assert.deepEqual([t.productId, t.productName], [p2, 'Псодерм']);
  assert.equal((await admin('PATCH', `/api/targets/${t.id}`, { productId: '' })).status, 200);
  t = (await list()).find((x) => x.code === 'T3');
  assert.equal(t.productId, ''); assert.equal(t.productName, 'Псодерм');
});

test('repeat customers: same last 10 digits of the phone, cancelled orders do not count, manual toggle', { skip }, async () => {
  const a = await mkOrder({ name: 'A', phone: '+7 (701) 111-22-33' });
  assert.equal((await orderOf(a)).isRepeat, false);
  const b = await mkOrder({ name: 'B', phone: '87011112233' });
  assert.equal((await orderOf(b)).isRepeat, true);
  const c = await mkOrder({ name: 'C', phone: '' });
  const c2 = await mkOrder({ name: 'C2', phone: '' });
  assert.equal((await orderOf(c)).isRepeat, false); assert.equal((await orderOf(c2)).isRepeat, false); // empty phone never repeats
  const x = await mkOrder({ name: 'X', phone: '+7 702 555 66 77', status: 'cancel' });
  const y = await mkOrder({ name: 'Y', phone: '7025556677' });
  assert.equal((await orderOf(y)).isRepeat, false); // the earlier one was cancelled
  const z = await mkOrder({ name: 'Z', phone: '+77025556677' });
  assert.equal((await orderOf(z)).isRepeat, true);  // y is a live earlier order
  assert.equal((await admin('PATCH', `/api/orders/${a}`, { isRepeat: true })).status, 200);
  assert.equal((await orderOf(a)).isRepeat, true);
  assert.equal((await admin('PATCH', `/api/orders/${b}`, { isRepeat: false })).status, 200);
  assert.equal((await orderOf(b)).isRepeat, false);
  const forced = await mkOrder({ name: 'F', phone: '+7 777 000 00 01', isRepeat: true });
  assert.equal((await orderOf(forced)).isRepeat, true);
  assert.ok(x);
});

test('migration 0010 backfills is_repeat (earlier non-cancelled order with the same phone key)', { skip }, async () => {
  const old = await mf.getD1Database('OLD');
  for (const f of fs.readdirSync(MIG).sort().filter((x) => x < '0010')) await applySql(old, path.join(MIG, f));
  const ts = '2026-11-01T00:00:00.000Z';
  const rows = [[1, 'new', '+7 (701) 111-22-33'], [2, 'paid', '8 701 111 22 33'], [3, 'cancel', '77029998877'], [4, 'new', '7 702 999 88 77'], [5, 'new', ''], [6, 'new', ''], [7, 'new', '+7 701 111 22 33']];
  for (const [num, st, ph] of rows) await old.prepare("INSERT INTO orders (num, status, name, phone, created_at, updated_at) VALUES (?, ?, 'n', ?, ?, ?)").bind(num, st, ph, ts, ts).run();
  await applySql(old, path.join(MIG, '0010_ads.sql'));
  const { results } = await old.prepare('SELECT num, is_repeat FROM orders ORDER BY num').all();
  // 1 first; 2 same phone as 1 -> repeat; 3 first (cancelled itself); 4 earlier order 3 was cancelled -> not repeat; 5, 6 empty phone; 7 repeat
  assert.deepEqual(results.map((r) => r.is_repeat), [0, 1, 0, 0, 0, 0, 1]);
});

/* ---------- upsell ---------- */
test('upsell: create with items, orderOut items[] and total, validation (max 5, product exists and active, qty 1..1000, sum >= 0)', { skip }, async () => {
  const id = await mkOrder({ name: 'Up', productId: p1, sum: 10000, items: [{ productId: p2, qty: 2, sum: 5000 }] });
  const o = await orderOf(id);
  assert.equal(o.items.length, 1);
  assert.deepEqual([o.items[0].productId, o.items[0].productName, o.items[0].qty, o.items[0].sum], [p2, 'Псодерм', 2, 5000]);
  assert.equal(o.sum, 10000); assert.equal(o.total, 15000);
  const plain = await orderOf(await mkOrder({ name: 'Plain', sum: 700 }));
  assert.deepEqual([plain.items, plain.total], [[], 700]);
  const six = Array.from({ length: 6 }, () => ({ productId: p2, qty: 1, sum: 1 }));
  const five = six.slice(0, 5);
  for (const bad of [six, [{ productId: 'nope', qty: 1, sum: 1 }], [{ productId: p2, qty: 0, sum: 1 }], [{ productId: p2, qty: 1001, sum: 1 }], [{ productId: p2, qty: 1, sum: -1 }], 'x', [null]]) {
    const r = await admin('POST', '/api/orders', { name: 'Bad', items: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await admin('POST', '/api/orders', { name: 'Five', items: five })).status, 201);
  const off = (await (await admin('POST', '/api/products', { name: 'Снят', price: 1, stock: 1 })).json()).id;
  await admin('PATCH', `/api/products/${off}`, { active: false });
  assert.equal((await admin('POST', '/api/orders', { name: 'Off', items: [{ productId: off, qty: 1, sum: 1 }] })).status, 400);
});

test('upsell: update replaces / clears the lines, no-op when unchanged, audited; an inactive product already on the order may stay', { skip }, async () => {
  const id = await mkOrder({ name: 'Upd', productId: p1, sum: 10000, items: [{ productId: p2, qty: 1, sum: 2500 }] });
  assert.equal((await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 1, sum: 2500 }] })).status, 200);
  assert.equal((await (await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 1, sum: 2500 }] })).json()).changed, false);
  await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 3, sum: 7500 }, { productId: p1, qty: 1, sum: 10000 }] });
  let o = await orderOf(id);
  assert.deepEqual(o.items.map((i) => [i.productId, i.qty, i.sum]), [[p2, 3, 7500], [p1, 1, 10000]]); assert.equal(o.total, 27500);
  await admin('PATCH', `/api/products/${p2}`, { active: false });
  assert.equal((await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 4, sum: 7500 }] })).status, 200);
  assert.equal((await admin('POST', '/api/orders', { name: 'N', items: [{ productId: p2, qty: 1, sum: 1 }] })).status, 400);
  await admin('PATCH', `/api/products/${p2}`, { active: true });
  await admin('PATCH', `/api/orders/${id}`, { items: [] });
  o = await orderOf(id);
  assert.deepEqual([o.items, o.total], [[], 10000]);
  const hist = (await jget(`/api/orders/${id}/audit`)).audit;
  assert.ok(hist.some((a) => a.action === 'edit' && /items/.test(a.detail)));
  await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 1, sum: 1 }] });
  await admin('DELETE', `/api/orders/${id}`);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').bind(parseInt(id, 10)).first()).n, 0);
});

test('upsell stock: main + each line deducted once on «Отправлен»; later changes of the lines do not deduct again', { skip }, async () => {
  const s1 = await stockOf(p1), s2 = await stockOf(p2);
  const id = await mkOrder({ name: 'Stock', productId: p1, qty: 2, items: [{ productId: p2, qty: 3, sum: 7500 }, { productId: p1, qty: 1, sum: 1 }] });
  assert.equal(await stockOf(p1), s1); // nothing before shipping
  const r = await admin('PATCH', `/api/orders/${id}`, { status: 'sent', delivery: 'Курьер' });
  assert.equal(r.status, 200);
  assert.equal(await stockOf(p1), s1 - 2 - 1); // main 2 + line 1 of the same product
  assert.equal(await stockOf(p2), s2 - 3);
  await admin('PATCH', `/api/orders/${id}`, { status: 'sent', comment: 'again' });
  await admin('PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 9, sum: 1 }] }); // changed after shipment: documented, no re-deduction
  assert.equal(await stockOf(p1), s1 - 3); assert.equal(await stockOf(p2), s2 - 3);
  // created straight as sent, with the lines in the same request: deducted once as well
  const t1 = await stockOf(p1), t2 = await stockOf(p2);
  await mkOrder({ name: 'Direct', productId: p1, qty: 1, status: 'sent', delivery: 'Курьер', items: [{ productId: p2, qty: 2, sum: 1 }] });
  assert.equal(await stockOf(p1), t1 - 1); assert.equal(await stockOf(p2), t2 - 2);
  // lines and status in ONE patch
  const id3 = await mkOrder({ name: 'OnePatch', productId: p1, qty: 1 });
  await admin('PATCH', `/api/orders/${id3}`, { status: 'sent', delivery: 'Курьер', items: [{ productId: p2, qty: 4, sum: 1 }] });
  assert.equal(await stockOf(p2), t2 - 2 - 4);
});

test('upsell stock via the Kazpost registry import: lines deducted once', { skip }, async () => {
  const id = await mkOrder({ name: 'Kaz', productId: p1, qty: 1, items: [{ productId: p2, qty: 2, sum: 5000 }] });
  const s1 = await stockOf(p1), s2 = await stockOf(p2);
  const apply = () => admin('POST', '/api/kazpost/apply', { pairs: [{ track: 'RR123456789KZ', orderId: parseInt(id, 10) }] });
  let r = await apply();
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(await stockOf(p1), s1 - 1); assert.equal(await stockOf(p2), s2 - 2);
  r = await apply(); // same pair again: already sent
  assert.equal(await stockOf(p2), s2 - 2);
});

test('upsell: a manager can add and edit lines', { skip }, async () => {
  let r = await api(mgrCookie, 'POST', '/api/orders', { name: 'Mgr', productId: p1, sum: 10000, items: [{ productId: p2, qty: 1, sum: 2500 }] });
  assert.equal(r.status, 201);
  const id = String((await r.json()).id);
  r = await api(mgrCookie, 'PATCH', `/api/orders/${id}`, { items: [{ productId: p2, qty: 2, sum: 5000 }] });
  assert.equal(r.status, 200);
  const o = (await (await api(mgrCookie, 'GET', '/api/orders')).json()).orders.find((x) => x.id === id);
  assert.deepEqual([o.items[0].qty, o.total], [2, 15000]);
});

// Chat -> order field extraction: pure rules (public/extract.js, ES copy src/extract.js) and orderFromChat on miniflare.
// Run: node --test test/*.test.js   (the Worker part is skipped without miniflare)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractOrderFields: ex } = require('../public/extract.js');

const E = (fullName = '', city = '', address = '', index = '') => ({ fullName, city, address, index });

/* [title, messages NEWEST FIRST, expected] */
const CASES = [
  ['name line + city line + address pieces', ['Иванова Анна Сергеевна\nг. Алматы, мкр Самал-2, д. 33, кв 12'], E('Иванова Анна Сергеевна', 'Алматы', 'мкр Самал-2, д. 33, кв 12')],
  ['one line, name at the end', ['Астана ул Кенесары 40 кв 15, Серикова Айгуль'], E('Серикова Айгуль', 'Астана', 'ул Кенесары 40 кв 15')],
  ['ФИО marker + index word', ['ФИО: Нурланов Ерлан Маратович, Караганда, ул. Ерубаева 50, индекс 100000'], E('Нурланов Ерлан Маратович', 'Караганда', 'ул. Ерубаева 50', '100000')],
  ['«Меня зовут» + first name only', ['Меня зовут Динара. Шымкент, мкр Нурсат 2 дом 15 кв 7'], E('Динара', 'Шымкент', 'мкр Нурсат 2 дом 15 кв 7')],
  ['greeting + product: nothing', ['Добрый день! Хочу заказать отпариватель'], E()],
  ['price question: nothing', ['Сколько стоит?'], E()],
  ['Kazakh: -ұлы, қ., көшесі', ['Ахметов Бауыржан Серікұлы, Тараз қ., Төле би көшесі 12'], E('Ахметов Бауыржан Серікұлы', 'Тараз', 'Төле би көшесі 12')],
  ['village in a region', ['Алматинская обл, Карасайский р-н, с. Каскелен, ул Абая 5'], E('', 'Каскелен', 'Алматинская обл, Карасайский р-н, с. Каскелен, ул Абая 5')],
  ['multi-message: address newest, name older', ['Алматы, ул Абая 10 кв 5', 'Иванова Анна'], E('Иванова Анна', 'Алматы', 'ул Абая 10 кв 5')],
  ['multi-message: name newest, address older', ['Серикова Айгуль Булатовна', 'Астана, пр. Туран 37, кв. 55'], E('Серикова Айгуль Булатовна', 'Астана', 'пр. Туран 37, кв. 55')],
  ['multi-message: one field per message', ['050000', 'Индекс', 'Алматы', 'ул Гоголя 5', 'Меня зовут Айгерим Нургалиева'], E('Айгерим Нургалиева', 'Алматы', 'ул Гоголя 5')],
  ['newest address wins over an older one', ['г. Павлодар, ул Ломова 45', 'Караганда, ул Гоголя 1'], E('', 'Павлодар', 'ул Ломова 45')],
  ['phone number is not an index', ['Мой номер 87011234567, г. Алматы, ул. Абая 10 кв 5'], E('', 'Алматы', 'ул. Абая 10 кв 5')],
  ['phone alone: nothing', ['87011234567'], E()],
  ['price is not an index', ['Оплатил 100000 тг, г. Астана, пр. Республики 5'], E('', 'Астана', 'пр. Республики 5')],
  ['small sum is not an index', ['2100 тг'], E()],
  ['price word without currency is not an index', ['Итого 150000, Алматы ул Абая 5'], E('', 'Алматы', 'ул Абая 5')],
  ['index next to the word', ['Индекс 050000'], E('', '', '', '050000')],
  ['standalone index in an address message', ['Алматы, ул Абая 5, 050000'], E('', 'Алматы', 'ул Абая 5', '050000')],
  ['numbered list', ['1. Иванов Иван\n2. Алматы\n3. ул Абая 5 кв 3\n4. 050000'], E('Иванов Иван', 'Алматы', 'ул Абая 5 кв 3', '050000')],
  ['ALL CAPS', ['ИВАНОВ ИВАН ИВАНОВИЧ\nАЛМАТЫ УЛ АБАЯ 5'], E('Иванов Иван Иванович', 'Алматы', 'УЛ АБАЯ 5')],
  ['Нур-Султан = Астана, name on the next line', ['Нур-Султан, пр. Туран 37, кв. 55\nСадыкова Меруерт Асылбековна'], E('Садыкова Меруерт Асылбековна', 'Астана', 'пр. Туран 37, кв. 55')],
  ['street named like a city is not the city', ['Астана ул Туркестан 5 кв 1'], E('', 'Астана', 'ул Туркестан 5 кв 1')],
  ['street named after a city name form', ['Алматы, ул Сатпаева 22, кв 4'], E('', 'Алматы', 'ул Сатпаева 22, кв 4')],
  ['unknown town after «г.»', ['г. Тайынша, ул Мира 3'], E('', 'Тайынша', 'ул Мира 3')],
  ['greeting before the name', ['Здравствуйте Анна Иванова'], E('Анна Иванова')],
  ['«Доставка на дом» is not an address', ['Доставка на дом можно?'], E()],
  ['product-like capitalised words are not a name', ['Новый Магазин на Абая'], E()],
  ['phone between name and address', ['Серик Нурпеисов, 87051112233, Кызылорда, ул Абая 15'], E('Серик Нурпеисов', 'Кызылорда', 'ул Абая 15')],
  ['lower-case marker and name', ['мое имя динара, живу в алматы'], E('Динара', 'Алматы')],
  ['no messages', [], E()]
];
for (const [title, msgs, want] of CASES) test('extract: ' + title, () => assert.deepEqual(ex(msgs), want));

test('extract: only the 30 newest messages are scanned', () => {
  const old = ['Иванова Анна, Алматы, ул Абая 5'];
  const filler = Array.from({ length: 30 }, () => 'Хорошо');
  assert.deepEqual(ex(filler.concat(old)), E());
  assert.equal(ex(filler.slice(1).concat(old)).city, 'Алматы');
});
test('extract: junk input does not throw', () => {
  assert.deepEqual(ex(null), E());
  assert.deepEqual(ex([null, undefined, '', 5, '   ']), E());
});

test('src/extract.js is the generated ES copy of public/extract.js', () => {
  const before = fs.readFileSync(path.join(__dirname, '../src/extract.js'), 'utf8');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/sync-extract.js')]);
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/extract.js'), 'utf8'), before, 'run: node scripts/sync-extract.js');
});

/* ---------- orderFromChat on miniflare ---------- */
const SRC = path.join(__dirname, '../src');
let Miniflare = null;
try { ({ Miniflare } = require('miniflare')); } catch (e) { /* not installed */ }
const skip = Miniflare ? false : 'miniflare is not installed (npm i wrangler@3.114.17)';
const ORIGIN = 'http://crm.test';
const KEY = 'test-api-key-0123456789';
let mf, db, cookie;

before(async () => {
  if (!Miniflare) return;
  mf = new Miniflare({
    modules: ['worker.js', 'wa.js', 'source.js', 'extract.js', 'fx.js', 'connector_script.js', 'connector_windows.js'].map((f) => ({ type: 'ESModule', path: f, contents: fs.readFileSync(path.join(SRC, f), 'utf8') })),
    compatibilityDate: '2025-01-15', d1Databases: { DB: 'extractdb' }, bindings: { CRM_API_KEY: KEY }
  });
  db = await mf.getD1Database('DB');
  const dir = path.join(__dirname, '../migrations');
  for (const f of fs.readdirSync(dir).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(st).run();
  }
  let r = await mf.dispatchFetch(ORIGIN + '/api/bootstrap', { method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.kz', name: 'Админ', password: 'long-password-123' }) });
  assert.equal(r.status, 201);
  r = await mf.dispatchFetch(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'a@b.kz', password: 'long-password-123' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { if (mf) await mf.dispose(); });
const admin = (method, p, body) => mf.dispatchFetch(ORIGIN + p, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

async function seedChat(extId, profile, texts /* oldest first */) {
  const ts = '2026-01-01T10:00:00.000Z';
  const c = await db.prepare("INSERT INTO contacts (channel, ext_id, phone, name, created_at, updated_at) VALUES ('whatsapp', ?, ?, ?, ?, ?) RETURNING id")
    .bind(extId, extId, profile, ts, ts).first();
  let i = 0;
  for (const t of texts) {
    const at = new Date(Date.parse(ts) + 60000 * ++i).toISOString();
    await db.prepare("INSERT INTO messages (contact_id, direction, type, body, ts, created_at) VALUES (?, 'in', 'text', ?, ?, ?)").bind(c.id, t, at, at).run();
  }
  return c.id;
}
const orderOf = async (id) => (await (await admin('GET', '/api/orders')).json()).orders.find((o) => o.id === id);

test('orderFromChat fills name, city and address from the messages; the comment stays the last message', { skip }, async () => {
  const cid = await seedChat('77011110001', 'Aika WA', ['Добрый день! Хочу заказать', 'Серикова Айгуль, Астана, ул Кенесары 40 кв 15, индекс 010000', 'Жду звонка']);
  const r = await admin('POST', '/api/chats/' + cid + '/order', {});
  assert.equal(r.status, 201);
  const o = await orderOf((await r.json()).id);
  assert.equal(o.name, 'Серикова Айгуль');
  assert.equal(o.city, 'Астана');
  assert.equal(o.address, 'ул Кенесары 40 кв 15, индекс 010000');
  assert.equal(o.comment, 'Жду звонка');
});
test('orderFromChat keeps the WhatsApp name and leaves city/address empty when nothing is found', { skip }, async () => {
  const cid = await seedChat('77011110002', 'Мария WA', ['Сколько стоит?']);
  const r = await admin('POST', '/api/chats/' + cid + '/order', {});
  const o = await orderOf((await r.json()).id);
  assert.equal(o.name, 'Мария WA');
  assert.equal(o.city, '');
  assert.equal(o.address, '');
});

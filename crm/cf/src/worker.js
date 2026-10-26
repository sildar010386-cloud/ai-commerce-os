// Bikas CRM: Cloudflare Worker (REST API under /api/*) + static UI from ./public + D1 (SQLite).
// Plain JS, no framework, no build step. All SQL is parameterized (prepare/bind).
// User-facing messages are in Russian. Client names and phones are never logged.

const GITHUB_REPO = 'sildar010386-cloud/ai-commerce-os';
const PUBLISH_URL = `https://github.com/${GITHUB_REPO}/actions/workflows/publish.yml`;

const PBKDF2_ITERS = 25000; // ~5 ms: the free plan allows 10 ms CPU per request; login throttling covers guessing
const SESSION_DAYS = 30;
const MAX_FAILS = 10;
const LOCK_MIN = 15;
const MAX_BODY = 1024 * 1024;

const STATUSES = ['new', 'accepted', 'pay', 'reserve', 'paid', 'sent', 'done', 'cancel'];
const DELIVERY = ['Казпочта', 'Курьер', 'СДЭК'];
const LEAD_SOURCES = ['Threads', 'Instagram', 'TikTok', 'WhatsApp'];
const CONTENT_STATUSES = ['ждёт', 'вышел', 'в боте', 'ошибка', 'не одобрено'];
const SETTINGS_KEYS = ['wa1', 'wa2', 'payLink', 'templates', 'track_msg', 'track_url'];
const MANAGER_SETTINGS = ['wa1', 'wa2', 'payLink', 'track_msg', 'track_url'];
// Shown (and used) while the owner has not changed them in Настройки. Placeholders: {имя} {трек} {ссылка}; {трек} in the URL.
const DEFAULT_TRACK_MSG = 'Здравствуйте, {имя}! Ваш заказ отправлен Казпочтой. Трек-номер: {трек}. ' +
  'Где сейчас посылка — по ссылке: {ссылка} Спасибо за покупку!';
const DEFAULT_TRACK_URL = 'https://post.kz/services/postal/{трек}';
const SETTING_DEFAULTS = { track_msg: DEFAULT_TRACK_MSG, track_url: DEFAULT_TRACK_URL };
const TRACK_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const KZ_MAX_ITEMS = 500;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function toB64(buf) {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return toB64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(s) { return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

// Constant-time string comparison: both sides are hashed to a fixed length first, then compared without early exit.
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iters) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERS);
  return { pass_hash: toB64(bits), pass_salt: toB64(salt), pass_iters: PBKDF2_ITERS };
}
async function verifyPassword(password, row) {
  const bits = await pbkdf2(password, fromB64(row.pass_salt), row.pass_iters);
  return safeEqual(toB64(bits), row.pass_hash);
}

function str(v, max, field) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, `Поле «${field}» заполнено неверно`);
  const s = String(v).trim();
  if (s.length > max) fail(400, `Поле «${field}» слишком длинное`);
  return s;
}
function numIn(v, min, max, field, int) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n) || n < min || n > max) fail(400, `Поле «${field}» заполнено неверно`);
  return int ? Math.round(n) : n;
}
// Users sign in with their e-mail: trimmed and lower-cased before every lookup and store.
function cleanEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validEmail(s) { return s.length <= 254 && /^[^\s@,;<>()"]{1,64}@[^\s@,;<>()"]+\.[^\s@,;<>()"]{2,}$/.test(s); }
function validPassword(p) { return typeof p === 'string' && p.length >= 10 && p.length <= 200; }

/* ---------- responses / security headers ---------- */
function secure(resp, { api } = {}) {
  const h = new Headers(resp.headers);
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cache-Control', api ? 'no-store' : 'no-cache');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
function json(data, status = 200, headers) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (headers) for (const k of Object.keys(headers)) h.append(k, headers[k]);
  return new Response(JSON.stringify(data), { status, headers: h });
}

/* ---------- request plumbing ---------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) fail(413, 'Слишком большой запрос');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object') fail(400, 'Некорректный запрос');
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, 'Некорректный запрос');
  }
}
async function hasApiKey(req, env) {
  const key = req.headers.get('X-Api-Key') || '';
  if (!env.CRM_API_KEY || !key) return false;
  return safeEqual(key, env.CRM_API_KEY);
}
// State-changing browser requests must be JSON and come from our own origin.
function checkCsrf(req, url) {
  const ct = (req.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) fail(403, 'Запрос отклонён (тип содержимого)');
  const origin = req.headers.get('Origin');
  let ok = false;
  if (origin) { try { ok = new URL(origin).host === url.host; } catch (e) { ok = false; } }
  if (!ok) fail(403, 'Запрос отклонён (источник)');
}
async function currentUser(req, env) {
  const tok = parseCookies(req).sid;
  if (!tok || tok.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1'
  ).bind(await sha256Hex(tok), nowIso()).first();
  if (!row) return null;
  row.tokenHash = await sha256Hex(tok);
  return row;
}
const requireAdmin = (user) => { if (user.role !== 'admin') fail(403, 'Нет доступа'); };

/* ---------- row mappers ---------- */
function orderOut(r) {
  return {
    id: String(r.id), num: r.num, status: r.status, name: r.name, phone: r.phone, city: r.city, address: r.address,
    productId: r.product_id, productName: r.product_name, qty: r.qty, sum: r.sum, source: r.source, post: r.post,
    comment: r.comment, delivery: r.delivery, track: r.track, remindAt: r.remind_at, reserveNote: r.reserve_note,
    cancelNote: r.cancel_note, example: !!r.example, stockDeducted: !!r.stock_deducted, trackSentAt: r.track_sent_at || '',
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
function productOut(r) { return { id: r.id, name: r.name, price: r.price, stock: r.stock, active: !!r.active }; }
function contentOut(r) {
  return {
    date: r.date, time: r.time, code: r.code, kind: r.kind, type: r.type, platform: r.platform, title: r.title,
    approved: !!r.approved, done: r.done, url: r.url, status: r.status
  };
}
function platformOf(kind) {
  if (kind === 'thread') return 'Threads';
  if (kind === 'carousel') return 'TikTok';
  if (kind === 'reel') return 'Reels';
  return '';
}

/* ---------- audit ---------- */
function auditStmt(env, actor, action, orderId, orderNum, detail) {
  return env.DB.prepare('INSERT INTO audit (at, actor, action, order_id, order_num, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nowIso(), actor, action, orderId == null ? null : orderId, orderNum == null ? null : orderNum, detail || '');
}

/* ---------- orders ---------- */
const ORDER_COLS = {
  name: 'name', phone: 'phone', city: 'city', address: 'address', productId: 'product_id', productName: 'product_name',
  qty: 'qty', sum: 'sum', source: 'source', post: 'post', comment: 'comment', delivery: 'delivery', track: 'track',
  remindAt: 'remind_at', reserveNote: 'reserve_note', cancelNote: 'cancel_note'
};
// Validates the order fields present in `b`; returns {col: value} (DB column names).
async function cleanOrderFields(env, b) {
  const f = {};
  if ('name' in b) f.name = str(b.name, 200, 'Имя');
  if ('phone' in b) f.phone = str(b.phone, 40, 'Телефон');
  if ('city' in b) f.city = str(b.city, 120, 'Город');
  if ('address' in b) f.address = str(b.address, 400, 'Адрес');
  if ('qty' in b) f.qty = numIn(b.qty, 1, 10000, 'Количество', true);
  if ('sum' in b) f.sum = numIn(b.sum, 0, 1e9, 'Сумма', false);
  if ('source' in b) f.source = str(b.source, 40, 'Откуда') || 'Другое';
  if ('post' in b) f.post = str(b.post, 500, 'Пост');
  if ('comment' in b) f.comment = str(b.comment, 4000, 'Комментарий');
  if ('track' in b) f.track = str(b.track, 100, 'Трек-номер');
  if ('delivery' in b) {
    const d = str(b.delivery, 40, 'Доставка');
    if (d && !DELIVERY.includes(d)) fail(400, 'Неизвестная служба доставки');
    f.delivery = d;
  }
  if ('remindAt' in b) {
    const d = str(b.remindAt, 10, 'Напомнить');
    if (d && !isDate(d)) fail(400, 'Дата напоминания указана неверно');
    f.remindAt = d;
  }
  if ('reserveNote' in b) f.reserveNote = str(b.reserveNote, 300, 'Причина');
  if ('cancelNote' in b) f.cancelNote = str(b.cancelNote, 300, 'Причина отказа');
  if ('productId' in b) {
    const pid = str(b.productId, 64, 'Товар');
    if (!pid) { f.productId = ''; f.productName = ''; }
    else {
      const p = await env.DB.prepare('SELECT id, name FROM products WHERE id = ?').bind(pid).first();
      if (!p) fail(400, 'Товар не найден');
      f.productId = p.id; f.productName = p.name;
    }
  } else if ('productName' in b) {
    f.productName = str(b.productName, 200, 'Товар');
  }
  const out = {};
  for (const k of Object.keys(f)) out[ORDER_COLS[k]] = f[k];
  return out;
}
function validateStatusFields(prevStatus, status, merged, touched) {
  if (status === 'reserve' && !isDate(merged.remind_at)) fail(400, 'Для резерва укажите дату «Напомнить»');
  if (status === 'sent' && (prevStatus !== 'sent' || touched.delivery || touched.track)) {
    if (!DELIVERY.includes(merged.delivery)) fail(400, 'Для отправки выберите службу доставки');
    if (merged.delivery !== 'Курьер' && !merged.track) fail(400, 'Для отправки впишите трек-номер');
  }
}

async function listOrders(env) {
  const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY num DESC LIMIT 5000').all();
  return results.map(orderOut);
}

async function insertOrder(env, cols, actor, action, detail) {
  const names = Object.keys(cols);
  const sql = `INSERT INTO orders (num, ${names.join(', ')}) VALUES ((SELECT COALESCE(MAX(num), 0) + 1 FROM orders), ${names.map(() => '?').join(', ')})` +
    (cols.lead_key ? ' ON CONFLICT(lead_key) DO NOTHING' : '');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await env.DB.prepare(sql).bind(...names.map((n) => cols[n])).run();
      if (!r.meta.changes) return null; // duplicate lead
      const row = await env.DB.prepare('SELECT id, num FROM orders WHERE id = ?').bind(r.meta.last_row_id).first();
      await auditStmt(env, actor, action, row.id, row.num, detail).run();
      return row;
    } catch (e) {
      if (attempt < 3 && /UNIQUE|constraint/i.test(String(e && e.message)) && !/lead_key/.test(String(e && e.message))) continue;
      throw e;
    }
  }
  return null;
}

async function createOrder(env, user, b) {
  const f = await cleanOrderFields(env, b);
  const status = b.status === undefined ? 'new' : b.status;
  if (!STATUSES.includes(status)) fail(400, 'Неизвестный статус');
  const cols = Object.assign({
    name: '', phone: '', city: '', address: '', qty: 1, sum: 0, source: 'Другое', post: '', comment: '',
    delivery: '', track: '', remind_at: '', reserve_note: '', cancel_note: '', product_id: '', product_name: ''
  }, f);
  if (!cols.name && !cols.phone) fail(400, 'Укажите имя или телефон');
  validateStatusFields('new', status, cols, { delivery: true, track: true });
  const ts = nowIso();
  // An order created straight as «Отправлен» is inserted as new and then moved, so the stock deduction runs once.
  cols.status = status === 'sent' ? 'new' : status; cols.created_at = ts; cols.updated_at = ts;
  const row = await insertOrder(env, cols, user.email, 'create', `status=${status}`);
  if (status === 'sent') await patchOrder(env, user, String(row.id), { status: 'sent' }, true);
  return row;
}

// Stock deduction on the transition to «Отправлен». Atomic: deducts only while the order is still marked as not deducted,
// so the number is subtracted exactly once (patchOrder and the Kazpost import both use this).
function stockDeductStmts(env, cur, qty) {
  if (!cur.product_id) return [];
  return [env.DB.prepare(
    'UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND stock_deducted = 0)'
  ).bind(qty, cur.product_id, cur.id)];
}

async function patchOrder(env, user, idStr, b, internal) {
  const id = parseInt(idStr, 10);
  if (!(id > 0)) fail(404, 'Заказ не найден');
  const cur = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!cur) fail(404, 'Заказ не найден');
  const f = await cleanOrderFields(env, b);
  let status = cur.status === 'work' ? 'accepted' : cur.status;
  const prev = status;
  if ('status' in b) {
    if (!STATUSES.includes(b.status)) fail(400, 'Неизвестный статус');
    status = b.status;
  }
  const merged = Object.assign({}, cur, f);
  validateStatusFields(prev, status, merged, { delivery: 'delivery' in f, track: 'track' in f });
  if (!merged.name && !merged.phone) fail(400, 'Укажите имя или телефон');

  const set = Object.assign({}, f);
  const changedFields = Object.keys(f).filter((k) => String(f[k]) !== String(cur[k]));
  const unchanged = Object.keys(f).filter((k) => !changedFields.includes(k));
  unchanged.forEach((k) => { delete set[k]; });
  if (status !== cur.status) set.status = status;
  const stmts = [];
  if (status === 'sent' && cur.status !== 'sent' && !cur.stock_deducted) {
    stmts.push(...stockDeductStmts(env, cur, merged.qty || 1));
    set.stock_deducted = 1;
  }
  if (changedFields.includes('track') && cur.track_sent_at) set.track_sent_at = ''; // a new track number has not been sent yet
  if (!Object.keys(set).length) return { changed: false };
  set.updated_at = nowIso();
  const names = Object.keys(set);
  stmts.push(env.DB.prepare(`UPDATE orders SET ${names.map((n) => n + ' = ?').join(', ')} WHERE id = ?`).bind(...names.map((n) => set[n]), id));
  if (status !== cur.status) stmts.push(auditStmt(env, user.email, 'status', id, cur.num, `${cur.status} -> ${status}`));
  const edited = changedFields.filter((k) => k !== 'status');
  if (edited.length && !internal) stmts.push(auditStmt(env, user.email, 'edit', id, cur.num, edited.join(',')));
  await env.DB.batch(stmts);
  return { changed: true };
}

async function deleteOrder(env, user, idStr) {
  const id = parseInt(idStr, 10);
  const cur = await env.DB.prepare('SELECT id, num FROM orders WHERE id = ?').bind(id).first();
  if (!cur) fail(404, 'Заказ не найден');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id),
    auditStmt(env, user.email, 'delete', id, cur.num, '')
  ]);
}

/* ---------- Kazpost registry import ----------
   The browser reads the registry PDF (public/kazpost.js) and sends the parcels here. preview matches them with orders,
   apply marks the chosen orders «Отправлен» (Казпочта + track) through the same stock rule as a manual status change.
   Names, phones and addresses of the registry are used only inside the request and are never stored or logged. */
const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const last10 = (s) => { const d = digitsOf(s); return d.length >= 10 ? d.slice(-10) : ''; };
const KZ_LETTERS = { 'ә': 'а', 'ғ': 'г', 'қ': 'к', 'ң': 'н', 'ө': 'о', 'ұ': 'у', 'ү': 'у', 'һ': 'х', 'і': 'и', 'ə': 'а', 'ё': 'е', 'й': 'и' };
// Lower-cased words of a name/address with Kazakh letters mapped to Russian ones.
function normWords(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[әғқңөұүһіəёй]/g, (c) => KZ_LETTERS[c])
    .replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
function wordMatch(a, b) { // a: word of the CRM name, b: word of the registry name
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);                                   // initial: «Н.»
  return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 3; // endings: Касымов/Касымова
}
function cityInAddress(city, addrNorm) {
  const w = normWords(city).join(' ');
  return !!w && addrNorm.includes(w);
}

function cleanKzItem(raw) {
  if (!raw || typeof raw !== 'object') fail(400, 'Некорректная строка реестра');
  const track = typeof raw.track === 'string' ? raw.track.trim().toUpperCase() : '';
  if (!TRACK_RE.test(track)) fail(400, 'Трек-номер в реестре указан неверно');
  return { track, name: str(raw.name, 200, 'ФИО'), phone: str(raw.phone, 40, 'Телефон'), address: str(raw.address, 600, 'Адрес') };
}

async function selectIn(env, sql, ids) { // `sql` contains one %IN% placeholder; D1 allows 100 bound parameters per query
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace('%IN%', part.map(() => '?').join(','))).bind(...part).all();
    out.push(...results);
  }
  return out;
}

async function kazpostPreview(env, b) {
  if (!Array.isArray(b.items)) fail(400, 'Нужен список items');
  if (!b.items.length) fail(400, 'В реестре нет посылок');
  if (b.items.length > KZ_MAX_ITEMS) fail(413, 'Слишком много посылок в реестре');
  const items = b.items.map(cleanKzItem);
  const seen = new Set();
  items.forEach((it) => { if (seen.has(it.track)) fail(400, 'Трек-номера в реестре повторяются'); seen.add(it.track); });

  // Orders that already carry one of these tracks (a repeated upload of the same registry).
  const held = await selectIn(env, 'SELECT id, num, name, status, track FROM orders WHERE track IN (%IN%)', items.map((i) => i.track));
  const heldBy = {};
  held.forEach((o) => { (heldBy[o.track] = heldBy[o.track] || []).push(o); });

  const { results: cand } = await env.DB.prepare(
    "SELECT id, num, name, phone, city, status FROM orders WHERE example = 0 AND status NOT IN ('cancel', 'done', 'sent') AND track = '' " +
    'ORDER BY num DESC LIMIT 2000'
  ).all();
  const byPhone = {};
  cand.forEach((o) => { const k = last10(o.phone); if (k) (byPhone[k] = byPhone[k] || []).push(o); });
  const used = new Set();

  const out = items.map((it) => {
    const row = { track: it.track, name: it.name, phone: it.phone, address: it.address, match: null, reason: '', already: false };
    const h = (heldBy[it.track] || []).filter((o) => o.status !== 'cancel');
    if (h.length) {
      const o = h[0];
      row.match = { id: String(o.id), num: o.num, name: o.name };
      if (o.status === 'sent' || o.status === 'done') { row.already = true; row.reason = 'уже отправлен'; return row; }
      if (!used.has(o.id)) { used.add(o.id); row.reason = 'трек уже указан в заказе'; return row; }
      row.match = null;
    }
    // 1) by the last 10 digits of the phone; several orders with the same phone: the most recent one
    const ph = last10(it.phone);
    const byP = ph ? (byPhone[ph] || []).filter((o) => !used.has(o.id)) : [];
    if (byP.length) {
      const o = byP[0]; // cand is sorted by num DESC
      used.add(o.id);
      row.match = { id: String(o.id), num: o.num, name: o.name };
      row.reason = 'по телефону' + (byP.length > 1 ? ' (несколько заказов, выбран последний)' : '');
      return row;
    }
    // 2) by name: every word of the CRM name is found in the registry name; the city must be in the address when the order has one
    const regWords = normWords(it.name), addrNorm = normWords(it.address).join(' ');
    const byN = cand.filter((o) => {
      if (used.has(o.id)) return false;
      const w = normWords(o.name);
      if (!w.length || !w.every((x) => regWords.some((y) => wordMatch(x, y)))) return false;
      const hasCity = normWords(o.city).length > 0, cityOk = hasCity && cityInAddress(o.city, addrNorm);
      if (w.length < 2) return cityOk;            // a single word is too weak without the city
      return !hasCity || cityOk;
    });
    if (byN.length) {
      const o = byN[0];
      used.add(o.id);
      row.match = { id: String(o.id), num: o.num, name: o.name };
      row.reason = (normWords(o.city).length ? 'по имени и городу' : 'по имени') + (byN.length > 1 ? ' (несколько совпадений, выбран последний)' : '');
    } else row.reason = 'не найден';
    return row;
  });
  return json({
    ok: true, items: out,
    matched: out.filter((r) => r.match && !r.already).length, already: out.filter((r) => r.already).length,
    candidates: cand.slice(0, 500).map((o) => ({ id: String(o.id), num: o.num, name: o.name, city: o.city, status: o.status }))
  });
}

async function kazpostApply(env, user, b) {
  if (!Array.isArray(b.pairs)) fail(400, 'Нужен список pairs');
  if (!b.pairs.length) fail(400, 'Не выбрано ни одного заказа');
  if (b.pairs.length > KZ_MAX_ITEMS) fail(413, 'Слишком много посылок');
  const pairs = b.pairs.map((p) => {
    if (!p || typeof p !== 'object') fail(400, 'Некорректная пара');
    const track = typeof p.track === 'string' ? p.track.trim().toUpperCase() : '';
    if (!TRACK_RE.test(track)) fail(400, 'Трек-номер указан неверно');
    const orderId = typeof p.orderId === 'number' ? p.orderId : parseInt(String(p.orderId), 10);
    if (!(orderId > 0) || !Number.isSafeInteger(orderId)) fail(400, 'Номер заказа указан неверно');
    return { track, orderId };
  });
  const tr = new Set(), ids = new Set();
  pairs.forEach((p) => {
    if (tr.has(p.track)) fail(400, 'Один трек-номер выбран дважды');
    if (ids.has(p.orderId)) fail(400, 'Один заказ выбран для двух посылок');
    tr.add(p.track); ids.add(p.orderId);
  });
  const rows = await selectIn(env, 'SELECT * FROM orders WHERE id IN (%IN%)', pairs.map((p) => p.orderId));
  const byId = {};
  rows.forEach((o) => { byId[o.id] = o; });
  const others = await selectIn(env, 'SELECT id, num, track FROM orders WHERE track IN (%IN%)', pairs.map((p) => p.track));

  const applied = [], skipped = [];
  let already = 0;
  const work = []; // [stmts] per order, so one order's statements always stay in the same batch
  const ts = nowIso();
  for (const p of pairs) {
    const cur = byId[p.orderId];
    if (!cur) { skipped.push({ track: p.track, orderId: p.orderId, reason: 'Заказ не найден' }); continue; }
    if (cur.status === 'cancel' || cur.status === 'done') { skipped.push({ track: p.track, orderId: p.orderId, num: cur.num, reason: 'Заказ отменён или уже получен' }); continue; }
    if (cur.track === p.track && cur.status === 'sent') { already++; continue; }
    if (cur.status === 'sent' && cur.track) { skipped.push({ track: p.track, orderId: p.orderId, num: cur.num, reason: 'Заказ уже отправлен с другим треком' }); continue; }
    const other = others.find((o) => o.track === p.track && o.id !== cur.id);
    if (other) { skipped.push({ track: p.track, orderId: p.orderId, num: cur.num, reason: `Этот трек уже у заказа № ${other.num}` }); continue; }
    const stmts = [];
    const set = { status: 'sent', delivery: 'Казпочта', track: p.track, updated_at: ts };
    if (cur.track !== p.track && cur.track_sent_at) set.track_sent_at = '';
    if (cur.status !== 'sent' && !cur.stock_deducted) { stmts.push(...stockDeductStmts(env, cur, cur.qty || 1)); set.stock_deducted = 1; }
    const names = Object.keys(set);
    stmts.push(env.DB.prepare(`UPDATE orders SET ${names.map((n) => n + ' = ?').join(', ')} WHERE id = ? AND status NOT IN ('cancel', 'done')`)
      .bind(...names.map((n) => set[n]), cur.id));
    if (cur.status !== 'sent') stmts.push(auditStmt(env, user.email, 'status', cur.id, cur.num, `${cur.status === 'work' ? 'accepted' : cur.status} -> sent`));
    stmts.push(auditStmt(env, user.email, 'kazpost', cur.id, cur.num, p.track));
    work.push(stmts);
    applied.push({ orderId: String(cur.id), num: cur.num, track: p.track });
  }
  // About 25 orders per batch: few round trips to D1 even for a registry of 100+ parcels.
  for (let i = 0; i < work.length; i += 25) await env.DB.batch(work.slice(i, i + 25).flat());
  return json({ ok: true, sent: applied.length, already, skipped, applied });
}

async function markTrackSent(env, user, idStr, b) {
  const id = parseInt(idStr, 10);
  const cur = await env.DB.prepare('SELECT id, num, track FROM orders WHERE id = ?').bind(id).first();
  if (!cur) fail(404, 'Заказ не найден');
  if (!cur.track) fail(400, 'У заказа нет трек-номера');
  const clear = b.sent === false;
  const at = clear ? '' : nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET track_sent_at = ? WHERE id = ?').bind(at, id),
    auditStmt(env, user.email, clear ? 'track_unsent' : 'track_sent', id, cur.num, '')
  ]);
  return json({ ok: true, trackSentAt: at });
}

/* ---------- auth ---------- */
async function login(env, b) {
  const lg = cleanEmail(b.email).slice(0, 254);
  const password = typeof b.password === 'string' ? b.password.slice(0, 300) : '';
  if (!lg || !password) fail(400, 'Введите почту и пароль');
  const now = new Date();
  const att = await env.DB.prepare('SELECT * FROM login_attempts WHERE email = ?').bind(lg).first();
  let fails = att ? att.fails : 0;
  if (att && att.locked_until && att.locked_until > now.toISOString()) {
    const mins = Math.max(1, Math.ceil((Date.parse(att.locked_until) - now.getTime()) / 60000));
    fail(429, `Слишком много неудачных попыток. Вход закрыт, попробуйте через ${mins} мин.`);
  }
  if (att && (att.locked_until || Date.parse(att.last_at) < now.getTime() - LOCK_MIN * 60000)) fails = 0; // lock over / stale failures
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(lg).first();
  let ok = false;
  if (user && user.active) ok = await verifyPassword(password, user);
  else await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERS); // same cost for unknown addresses
  if (!ok) {
    fails += 1;
    const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MIN * 60000).toISOString() : null;
    await env.DB.prepare(
      'INSERT INTO login_attempts (email, fails, locked_until, last_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(email) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, last_at = excluded.last_at'
    ).bind(lg, fails, lock, now.toISOString()).run();
    fail(401, 'Неверная почта или пароль');
  }
  const token = randomToken();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(lg),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now.toISOString()),
    env.DB.prepare('DELETE FROM login_attempts WHERE last_at < ? AND (locked_until IS NULL OR locked_until < ?)')
      .bind(new Date(now.getTime() - 86400000).toISOString(), now.toISOString()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), user.id, now.toISOString(), exp)
  ]);
  return json({ ok: true, user: { email: user.email, name: user.name, role: user.role } }, 200,
    { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}

/* ---------- settings / content / misc ---------- */
async function getSettings(env, keys) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  keys.forEach((k) => { out[k] = ''; });
  results.forEach((r) => { if (keys.includes(r.key)) out[r.key] = r.value; });
  keys.forEach((k) => { if (!out[k] && SETTING_DEFAULTS[k]) out[k] = SETTING_DEFAULTS[k]; });
  return out;
}

function deriveContentStatus(it) {
  if (it.done) return it.kind === 'carousel' ? 'в боте' : 'вышел';
  return it.approved ? 'ждёт' : 'не одобрено';
}

async function contentSync(env, b) {
  if (!Array.isArray(b.items)) fail(400, 'Нужен список items');
  if (b.items.length > 1000) fail(413, 'Слишком много строк');
  const ts = nowIso();
  const stmts = [];
  for (const raw of b.items) {
    if (!raw || typeof raw !== 'object') fail(400, 'Некорректная строка плана');
    if (!isDate(raw.date) || !isTime(raw.time)) fail(400, 'Некорректные дата или время в плане');
    const it = {
      date: raw.date, time: raw.time, code: str(raw.code, 40, 'code'), kind: str(raw.kind, 40, 'kind'),
      type: str(raw.type, 40, 'type'), title: str(raw.title, 500, 'title'), approved: !!raw.approved,
      done: raw.done ? str(raw.done, 40, 'done') : '', url: str(raw.url, 1000, 'url')
    };
    stmts.push(env.DB.prepare(
      'INSERT INTO content (date, time, code, kind, type, platform, title, approved, done, url, status, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date, time) DO UPDATE SET ' +
      'code = excluded.code, kind = excluded.kind, type = excluded.type, platform = excluded.platform, title = excluded.title, ' +
      'approved = excluded.approved, done = excluded.done, url = excluded.url, updated_at = excluded.updated_at, ' +
      "status = CASE WHEN content.status = 'ошибка' AND excluded.status = 'ждёт' THEN 'ошибка' ELSE excluded.status END"
    ).bind(it.date, it.time, it.code, it.kind, it.type, platformOf(it.kind), it.title, it.approved ? 1 : 0, it.done, it.url,
      deriveContentStatus(it), ts));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, count: stmts.length });
}

async function contentStatus(env, b) {
  if (!isDate(b.date) || !isTime(b.time)) fail(400, 'Некорректные дата или время');
  if (!CONTENT_STATUSES.includes(b.status)) fail(400, 'Неизвестный статус');
  const url = b.url == null ? null : str(b.url, 1000, 'url');
  const r = await env.DB.prepare(
    'UPDATE content SET status = ?, url = COALESCE(?, url), updated_at = ? WHERE date = ? AND time = ?'
  ).bind(b.status, url, nowIso(), b.date, b.time).run();
  if (!r.meta.changes) fail(404, 'Слот не найден');
  return json({ ok: true });
}

async function leadHook(env, b) {
  const source = str(b.source, 40, 'source');
  if (!LEAD_SOURCES.includes(source)) fail(400, 'Неизвестный источник');
  const user = str(b.user, 100, 'user');
  if (!user) fail(400, 'Нужен user');
  const text = str(b.text, 4000, 'text');
  const permalink = str(b.permalink, 500, 'permalink');
  const key = [source, user.toLowerCase(), permalink].join('|');
  const dup = await env.DB.prepare('SELECT id, num FROM orders WHERE lead_key = ?').bind(key).first();
  if (dup) return json({ ok: true, created: false, num: dup.num });
  const ts = nowIso();
  const row = await insertOrder(env, {
    status: 'new', name: user, source, post: permalink, comment: text, lead_key: key, created_at: ts, updated_at: ts
  }, 'hook:' + source, 'lead', '');
  if (!row) return json({ ok: true, created: false });
  return json({ ok: true, created: true, num: row.num }, 201);
}

async function botStatsHook(env, b) {
  const d = {};
  ['handled', 'orders', 'payLinks', 'calledHuman'].forEach((k) => { if (k in b) d[k] = numIn(b[k], 0, 1e9, k, true); });
  if (Array.isArray(b.issues)) {
    d.issues = b.issues.slice(0, 50).map((i) => ({
      time: str(i && i.time, 20, 'time'), client: str(i && i.client, 100, 'client'),
      question: str(i && i.question, 500, 'question'), reason: str(i && i.reason, 300, 'reason')
    }));
  }
  const cur = await env.DB.prepare("SELECT data FROM bot_stats WHERE key = 'main'").first();
  const merged = Object.assign(cur ? JSON.parse(cur.data) : {}, d);
  await env.DB.prepare(
    "INSERT INTO bot_stats (key, data) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data"
  ).bind(JSON.stringify(merged)).run();
  return json({ ok: true });
}

async function publish(env, user, b) {
  const date = b.date ? str(b.date, 10, 'date') : '';
  const time = b.time ? str(b.time, 5, 'time') : '';
  if (date && !isDate(date)) fail(400, 'Дата указана неверно');
  if (time && !isTime(time)) fail(400, 'Время указано неверно');
  if (time && !date) fail(400, 'Укажите дату слота');
  if (!env.GH_DISPATCH_TOKEN) {
    return json({ ok: false, manual: true, url: PUBLISH_URL, error: 'Автозапуск не настроен: откройте страницу GitHub и нажмите «Run workflow».' }, 501);
  }
  let resp;
  try {
    resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/publish.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bikas-crm', 'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: env.GH_DISPATCH_REF || 'claude/ai-ecommerce-automation-3n1lgz', inputs: { date, time } })
    });
  } catch (e) {
    fail(502, 'Не удалось связаться с GitHub. Попробуйте позже.', { url: PUBLISH_URL });
  }
  if (resp.status !== 204) {
    fail(502, `GitHub не принял запуск (код ${resp.status}). Проверьте токен или запустите вручную.`, { url: PUBLISH_URL });
  }
  await auditStmt(env, user.email, 'publish', null, null, `${date} ${time}`.trim()).run();
  return json({ ok: true });
}

/* ---------- users ---------- */
const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, note: u.note, role: u.role, active: !!u.active, createdAt: u.created_at });

async function createUser(env, b, role) {
  const lg = cleanEmail(b.email);
  if (!validEmail(lg)) fail(400, 'Укажите почту в формате name@example.com');
  if (!validPassword(b.password)) fail(400, 'Пароль должен быть не короче 10 символов');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(lg).first();
  if (exists) fail(409, 'Такая почта уже есть');
  const h = await hashPassword(b.password);
  await env.DB.prepare(
    'INSERT INTO users (email, name, note, role, pass_hash, pass_salt, pass_iters, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
  ).bind(lg, str(b.name, 100, 'Имя'), str(b.note, 300, 'Заметка'), role, h.pass_hash, h.pass_salt, h.pass_iters, nowIso()).run();
  return lg;
}

/* ---------- AI images (free Workers AI quota) ----------
   tools/ai/cf_image.py asks for carousel/post pictures here: FLUX.1 schnell on Cloudflare Workers AI
   (binding AI in wrangler.toml). Returns the JPEG bytes; the caller crops to the slide size. */
async function imageHook(env, b) {
  if (!env.AI) fail(501, 'Workers AI не подключён');
  const prompt = str(b.prompt, 2000, 'prompt');
  if (!prompt) fail(400, 'Пустой prompt');
  let out;
  try {
    out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 8 });  // the model takes no seed
  } catch (e) {  // key-protected machine endpoint: the reason helps fix quota/permission problems
    fail(502, 'Workers AI: ' + String((e && e.message) || e).slice(0, 300));
  }
  if (!out || !out.image) fail(502, 'Генерация не удалась');
  const bytes = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
}

/* ---------- AI comment replies (free Workers AI quota) ----------
   tools/threads/autoreply.py sends {system, post, comment}; the model answers with one short reply or SKIP. */
async function replyHook(env, b) {
  if (!env.AI) fail(501, 'Workers AI не подключён');
  const system = str(b.system, 4000, 'system'), post = str(b.post, 1000, 'post'), comment = str(b.comment, 1000, 'comment');
  if (!system || !comment) fail(400, 'Пустой запрос');
  let out;
  try {
    out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'system', content: system }, { role: 'user', content: `Пост: ${post}\nКомментарий: ${comment}` }],
      max_tokens: 160, temperature: 0.6
    });
  } catch (e) {
    fail(502, 'Workers AI: ' + String((e && e.message) || e).slice(0, 300));
  }
  return json({ reply: String((out && out.response) || '').trim() });
}

/* ---------- router ---------- */
async function api(req, env, url) {
  const m = req.method, p = url.pathname;
  let mt;

  // Machine endpoints: X-Api-Key, no cookie and no CSRF check.
  if (p === '/api/bootstrap' || p.startsWith('/api/hooks/')) {
    if (m !== 'POST') fail(405, 'Метод не поддерживается');
    if (!(await hasApiKey(req, env))) fail(401, 'Нет доступа');
    const b = await readJson(req);
    if (p === '/api/bootstrap') {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      if (c.n > 0) fail(409, 'Администратор уже создан');
      await createUser(env, b, 'admin');
      return json({ ok: true }, 201);
    }
    if (p === '/api/hooks/lead') return leadHook(env, b);
    if (p === '/api/hooks/content-sync') return contentSync(env, b);
    if (p === '/api/hooks/content-status') return contentStatus(env, b);
    if (p === '/api/hooks/bot-stats') return botStatsHook(env, b);
    if (p === '/api/hooks/image') return imageHook(env, b);
    if (p === '/api/hooks/reply') return replyHook(env, b);
    fail(404, 'Не найдено');
  }

  if (m !== 'GET' && m !== 'HEAD') checkCsrf(req, url);

  if (p === '/api/login' && m === 'POST') return login(env, await readJson(req));

  const user = await currentUser(req, env);
  // The page asks /api/me on load: answer 200 {user:null} when logged out, so the browser console stays clean.
  if (!user && p === '/api/me' && m === 'GET') return json({ user: null });
  if (!user) fail(401, 'Требуется вход');

  if (p === '/api/logout' && m === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p === '/api/me' && m === 'GET') {
    return json({
      user: { email: user.email, name: user.name, role: user.role },
      canDispatch: user.role === 'admin' && !!env.GH_DISPATCH_TOKEN, publishUrl: PUBLISH_URL
    });
  }
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readJson(req);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    if (typeof b.current !== 'string' || !(await verifyPassword(b.current, row))) fail(403, 'Текущий пароль неверный');
    if (!validPassword(b.password)) fail(400, 'Новый пароль должен быть не короче 10 символов');
    const h = await hashPassword(b.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iters = ? WHERE id = ?').bind(h.pass_hash, h.pass_salt, h.pass_iters, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash)
    ]);
    return json({ ok: true });
  }

  if (p === '/api/me/email' && m === 'POST') {
    const b = await readJson(req);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    if (typeof b.password !== 'string' || !(await verifyPassword(b.password, row))) fail(403, 'Пароль неверный');
    const em = cleanEmail(b.email);
    if (!validEmail(em)) fail(400, 'Укажите почту в формате name@example.com');
    const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(em, user.id).first();
    if (taken) fail(409, 'Такая почта уже есть');
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(em, user.id).run();
    return json({ ok: true, email: em });
  }

  /* orders (admin + manager) */
  if (p === '/api/orders') {
    if (m === 'GET') return json({ orders: await listOrders(env) });
    if (m === 'POST') {
      const row = await createOrder(env, user, await readJson(req));
      return json({ ok: true, id: String(row.id), num: row.num }, 201);
    }
  }
  if ((mt = p.match(/^\/api\/orders\/(\d+)$/))) {
    if (m === 'PATCH') return json(Object.assign({ ok: true }, await patchOrder(env, user, mt[1], await readJson(req))));
    if (m === 'DELETE') { requireAdmin(user); await deleteOrder(env, user, mt[1]); return json({ ok: true }); }
  }
  if ((mt = p.match(/^\/api\/orders\/(\d+)\/track-sent$/)) && m === 'POST') return markTrackSent(env, user, mt[1], await readJson(req));
  if (p === '/api/kazpost/preview' && m === 'POST') return kazpostPreview(env, await readJson(req));
  if (p === '/api/kazpost/apply' && m === 'POST') return kazpostApply(env, user, await readJson(req));
  if ((mt = p.match(/^\/api\/orders\/(\d+)\/audit$/)) && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM audit WHERE order_id = ? ORDER BY id DESC LIMIT 50')
      .bind(parseInt(mt[1], 10)).all();
    return json({ audit: results });
  }

  /* products: read for everyone, write for admin */
  if (p === '/api/products') {
    if (m === 'GET') {
      const q = user.role === 'admin' ? 'SELECT * FROM products' : 'SELECT * FROM products WHERE active = 1';
      const { results } = await env.DB.prepare(q).all();
      return json({ products: results.map(productOut) });
    }
    if (m === 'POST') {
      requireAdmin(user);
      const b = await readJson(req);
      const name = str(b.name, 200, 'Название');
      if (!name) fail(400, 'Введите название товара');
      const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
      await env.DB.prepare('INSERT INTO products (id, name, price, stock, active) VALUES (?, ?, ?, ?, 1)')
        .bind(id, name, numIn(b.price || 0, 0, 1e9, 'Цена', false), numIn(b.stock || 0, 0, 1e7, 'Остаток', true)).run();
      return json({ ok: true, id }, 201);
    }
  }
  if ((mt = p.match(/^\/api\/products\/([0-9a-f]{16})$/)) && m === 'PATCH') {
    requireAdmin(user);
    const b = await readJson(req);
    const set = {};
    if ('name' in b) { set.name = str(b.name, 200, 'Название'); if (!set.name) fail(400, 'Введите название товара'); }
    if ('price' in b) set.price = numIn(b.price, 0, 1e9, 'Цена', false);
    if ('stock' in b) set.stock = numIn(b.stock, 0, 1e7, 'Остаток', true);
    if ('active' in b) set.active = b.active ? 1 : 0;
    const names = Object.keys(set);
    if (!names.length) return json({ ok: true });
    const r = await env.DB.prepare(`UPDATE products SET ${names.map((n) => n + ' = ?').join(', ')} WHERE id = ?`)
      .bind(...names.map((n) => set[n]), mt[1]).run();
    if (!r.meta.changes) fail(404, 'Товар не найден');
    return json({ ok: true });
  }

  /* content: read for everyone */
  if (p === '/api/content' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM content ORDER BY date, time').all();
    return json({ content: results.map(contentOut) });
  }
  if (p === '/api/publish' && m === 'POST') { requireAdmin(user); return publish(env, user, await readJson(req)); }

  /* settings: managers read wa1, wa2, payLink only */
  if (p === '/api/settings') {
    if (m === 'GET') return json({ settings: await getSettings(env, user.role === 'admin' ? SETTINGS_KEYS : MANAGER_SETTINGS) });
    if (m === 'PUT') {
      requireAdmin(user);
      const b = await readJson(req);
      const stmts = [];
      for (const k of SETTINGS_KEYS) {
        if (!(k in b)) continue;
        const v = typeof b[k] === 'string' ? b[k] : '';
        if (v.length > 20000) fail(400, 'Слишком длинное значение');
        if (k === 'payLink' && v && !/^https?:\/\//i.test(v.trim())) fail(400, 'Ссылка на оплату должна начинаться с https://');
        if (k === 'track_url' && v.trim() && !(/^https:\/\//i.test(v.trim()) && v.includes('{трек}'))) {
          fail(400, 'Ссылка для отслеживания должна начинаться с https:// и содержать {трек}');
        }
        if (k === 'track_msg' && v.length > 2000) fail(400, 'Шаблон сообщения слишком длинный');
        stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(k, k === 'templates' || k === 'track_msg' ? v : v.trim()));
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ ok: true });
    }
  }

  /* everything below is admin only */
  if (p === '/api/finance' && m === 'GET') {
    requireAdmin(user);
    const { results } = await env.DB.prepare('SELECT key, data FROM finance').all();
    const out = {};
    results.forEach((r) => { try { out[r.key] = JSON.parse(r.data); } catch (e) { out[r.key] = {}; } });
    return json({ finance: out });
  }
  if ((mt = p.match(/^\/api\/finance\/([A-Za-z0-9_-]{1,64})$/)) && m === 'PUT') {
    requireAdmin(user);
    const b = await readJson(req);
    const keys = mt[1] === 'general' ? ['fixedMonth'] : ['buy', 'ship', 'pack', 'feePct', 'other'];
    const d = {};
    keys.forEach((k) => { d[k] = numIn(b[k] == null ? 0 : b[k], 0, 1e9, k, false); });
    await env.DB.prepare('INSERT INTO finance (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
      .bind(mt[1], JSON.stringify(d)).run();
    return json({ ok: true });
  }
  if (p === '/api/bot' && m === 'GET') {
    requireAdmin(user);
    const r = await env.DB.prepare("SELECT data FROM bot_stats WHERE key = 'main'").first();
    return json({ bot: r ? JSON.parse(r.data) : null });
  }
  if (p === '/api/users') {
    requireAdmin(user);
    if (m === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY role, email').all();
      return json({ users: results.map(userOut) });
    }
    if (m === 'POST') {
      const lg = await createUser(env, await readJson(req), 'manager');
      return json({ ok: true, email: lg }, 201);
    }
  }
  if ((mt = p.match(/^\/api\/users\/(\d+)$/)) && m === 'PATCH') {
    requireAdmin(user);
    const id = parseInt(mt[1], 10);
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) fail(404, 'Пользователь не найден');
    const b = await readJson(req);
    const set = {};
    if ('name' in b) set.name = str(b.name, 100, 'Имя');
    if ('note' in b) set.note = str(b.note, 300, 'Заметка');
    if ('active' in b) {
      if (target.id === user.id || target.role === 'admin') fail(400, 'Администратора отключить нельзя');
      set.active = b.active ? 1 : 0;
    }
    const names = Object.keys(set);
    if (!names.length) return json({ ok: true });
    const stmts = [env.DB.prepare(`UPDATE users SET ${names.map((n) => n + ' = ?').join(', ')} WHERE id = ?`).bind(...names.map((n) => set[n]), id)];
    if (set.active === 0) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/users\/(\d+)\/password$/)) && m === 'POST') {
    requireAdmin(user);
    const id = parseInt(mt[1], 10);
    const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
    if (!target) fail(404, 'Пользователь не найден');
    if (target.id === user.id) fail(400, 'Свой пароль меняйте в разделе «Мой пароль»');
    const b = await readJson(req);
    if (!validPassword(b.password)) fail(400, 'Пароль должен быть не короче 10 символов');
    const h = await hashPassword(b.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iters = ? WHERE id = ?').bind(h.pass_hash, h.pass_salt, h.pass_iters, id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM login_attempts WHERE email = (SELECT email FROM users WHERE id = ?)').bind(id)
    ]);
    return json({ ok: true });
  }

  fail(404, 'Не найдено');
}

/* ---------- punctual autopublishing ----------
   GitHub starts its own scheduled runs 10-40 min late, so a Cloudflare cron (wrangler.toml [triggers]) checks every
   5 minutes whether an approved slot is due and still waiting, and if so starts the publish workflow right away.
   GitHub's schedule stays as the backup; publish.yml runs one at a time and never posts a done slot twice. */
const MORNING_CRON = '0 4 * * *'; // must match wrangler.toml [triggers]

async function autoPublish(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const almaty = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const date = almaty.slice(0, 10), time = almaty.slice(11, 16);
  const due = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM content WHERE date = ? AND time <= ? AND approved = 1 AND status = 'ждёт'"
  ).bind(date, time).first();
  if (!due || !due.n) return;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'auto_dispatch_at'").first();
  if (last && Date.now() - Number(last.value) < 9 * 60 * 1000) return;  // a run started recently is still working
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/publish.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bikas-crm', 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: env.GH_DISPATCH_REF || 'claude/ai-ecommerce-automation-3n1lgz', inputs: { date: '', time: '' } })
  });
  if (resp.status !== 204) { console.error('auto publish dispatch failed:', resp.status); return; }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('auto_dispatch_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(Date.now())).run();
}

// 09:00 Almaty: start the morning report workflow (tools/stats/morning.py sends it once per day).
async function startMorningReport(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/morning.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bikas-crm', 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: env.GH_DISPATCH_REF || 'claude/ai-ecommerce-automation-3n1lgz' })
  });
  if (resp.status !== 204) console.error('morning report dispatch failed:', resp.status);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === MORNING_CRON ? startMorningReport(env) : autoPublish(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return secure(await api(req, env, url), { api: true });
      } catch (e) {
        if (e instanceof HttpError) return secure(json(Object.assign({ error: e.message }, e.extra), e.status), { api: true });
        console.error('api error:', e && e.message ? String(e.message).slice(0, 200) : 'unknown');
        return secure(json({ error: 'Внутренняя ошибка. Попробуйте ещё раз.' }, 500), { api: true });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return secure(new Response('Method Not Allowed', { status: 405 }));
    return secure(await env.ASSETS.fetch(req));
  }
};

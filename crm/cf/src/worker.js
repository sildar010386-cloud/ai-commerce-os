// Bikas CRM: Cloudflare Worker (REST API under /api/*) + static UI from ./public + D1 (SQLite).
// Plain JS, no framework, no build step. All SQL is parameterized (prepare/bind).
// User-facing messages are in Russian. Client names and phones are never logged.

import { detectSource } from './source.js';
import { parseWebhook, normalizeInboxEvents } from './wa.js';

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
    traffic: r.traffic || '', targetCode: r.target_code || '',
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
  remindAt: 'remind_at', reserveNote: 'reserve_note', cancelNote: 'cancel_note', traffic: 'traffic', targetCode: 'target_code'
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
  if ('traffic' in b) {
    const tr = str(b.traffic, 20, 'Трафик');
    if (tr && !['target', 'organic'].includes(tr)) fail(400, 'Трафик: «target» или «organic»');
    f.traffic = tr;
  }
  if ('targetCode' in b) f.targetCode = str(b.targetCode, 20, 'Код');
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

  // Meta webhook: verified by the verify token (GET) and the HMAC signature (POST), not by the CRM key.
  if (p === '/api/hooks/whatsapp') return whatsappHook(req, env, url);

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
    if (p === '/api/hooks/inbox') return inboxHook(env, b);
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
      canDispatch: user.role === 'admin' && !!env.GH_DISPATCH_TOKEN, publishUrl: PUBLISH_URL,
      waConnected: !!env.WA_TOKEN
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

  const inbox = await inboxApi(req, env, url, user);
  if (inbox) return inbox;

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

/* ---------- Inbox: WhatsApp chats, business numbers, ad ("target") texts ----------
   Connection: official WhatsApp Cloud API (Business app coexistence). Secrets: WA_TOKEN (send + media), WA_APP_SECRET
   (webhook signature), WA_VERIFY_TOKEN (webhook verification). Without them the inbox stays usable and says so.
   Client names, phones and message texts are never logged and never written to the audit table. */
const WA_GRAPH = 'https://graph.facebook.com/v21.0';
const WA_WINDOW_MS = 24 * 3600 * 1000;      // free-form replies are allowed 24 h after the client's last message
const TRAFFIC = ['target', 'organic', 'old'];
const NUMBER_STATUSES = ['active', 'blocked', 'off'];
const MSG_STATUSES = ['sent', 'delivered', 'read', 'failed'];
const MAX_HOOK_BODY = 4 * 1024 * 1024;
const MEDIA_TYPES = /^(image|audio|video)\/[a-z0-9.+-]+$|^application\/pdf$/i;

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, data));
}

function previewOf(msg, direction) {
  let t;
  switch (msg.type) {
    case 'text': t = msg.body; break;
    case 'voice': t = '[Голосовое]'; break;
    case 'audio': t = '[Аудио]'; break;
    case 'image': t = '[Фото]' + (msg.caption ? ' ' + msg.caption : ''); break;
    case 'video': t = '[Видео]' + (msg.caption ? ' ' + msg.caption : ''); break;
    case 'document': t = '[Файл]' + (msg.caption ? ' ' + msg.caption : ''); break;
    case 'sticker': t = '[Стикер]'; break;
    case 'location': t = '[Геолокация]'; break;
    case 'reaction': t = 'Реакция ' + msg.body; break;
    default: t = msg.body || '[Сообщение]';
  }
  return ((direction === 'out' ? 'Вы: ' : '') + String(t || '').replace(/\s+/g, ' ')).slice(0, 120);
}

// Finds the number by Cloud API id; a number added by hand (phone only) gets its id on the first webhook;
// an unknown number is created (not current), so a freshly connected reserve number works at once.
async function ensureWaNumber(env, cache, phoneNumberId, displayPhone, connection) {
  const key = phoneNumberId + '|' + displayPhone;
  if (cache.has(key)) return cache.get(key);
  let row = null;
  if (phoneNumberId) row = await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first();
  if (!row && displayPhone) {
    row = await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone = ?').bind(displayPhone).first();
    if (row && phoneNumberId && !row.phone_number_id) {
      await env.DB.prepare('UPDATE wa_numbers SET phone_number_id = ?, updated_at = ? WHERE id = ?').bind(phoneNumberId, nowIso(), row.id).run();
      row.phone_number_id = phoneNumberId;
    }
  }
  if (!row && (phoneNumberId || displayPhone)) {
    const ts = nowIso();
    await env.DB.prepare(
      "INSERT INTO wa_numbers (phone, label, phone_number_id, status, connection, is_current, note, created_at, updated_at) VALUES (?, '', ?, 'active', ?, 0, 'Добавлен автоматически', ?, ?) ON CONFLICT DO NOTHING"
    ).bind(displayPhone || phoneNumberId.replace(/\D/g, '') || phoneNumberId, phoneNumberId || null, connection, ts, ts).run();
    row = phoneNumberId ? await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first() : null;
    if (!row && displayPhone) row = await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone = ?').bind(displayPhone).first();
  }
  if (row) {
    // Every inbound event proves the number is connected; remember how (once per request).
    await env.DB.prepare("UPDATE wa_numbers SET last_seen_at = ?, connection = CASE WHEN connection = '' THEN ? ELSE connection END WHERE id = ?")
      .bind(nowIso(), connection, row.id).run();
  }
  cache.set(key, row || null);
  return row || null;
}

async function processWaEvent(env, ctx, ev) {
  if (ev.kind === 'status') {
    if (!MSG_STATUSES.includes(ev.status) || !ev.id) return;
    await env.DB.prepare(
      "UPDATE messages SET status = ?1 WHERE ext_msg_id = ?2 AND (?1 = 'failed' OR " +
      "CASE status WHEN 'received' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END < " +
      "CASE ?1 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END)"
    ).bind(ev.status, ev.id).run();
    return;
  }
  const msg = ev.msg;
  if (!ev.waId || !msg) return;
  if (msg.id && await env.DB.prepare('SELECT id FROM messages WHERE ext_msg_id = ?').bind(msg.id).first()) return; // webhook retry
  const number = await ensureWaNumber(env, ctx.numbers, ev.phoneNumberId, ev.displayPhone, ctx.connection);
  const live = ev.kind === 'message';
  const ts = msg.ts;

  let contact = await env.DB.prepare("SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?").bind(ev.waId).first();
  if (!contact) {
    // The source is decided once, on the first message: live inbound -> detect; history sync -> old; the owner wrote first -> organic.
    let src = { traffic: 'organic', platform: '', code: '', product: '' };
    if (ev.kind === 'history') src.traffic = 'old';
    else if (live) src = detectSource({ text: msg.body || msg.caption, referral: msg.referral, targets: ctx.targets });
    await env.DB.prepare(
      "INSERT INTO contacts (channel, ext_id, phone, name, traffic, platform, target_code, product_name, number_id, first_message_at, created_at, updated_at) " +
      "VALUES ('whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, ext_id) DO NOTHING"
    ).bind(ev.waId, ev.waId, ev.profileName || '', src.traffic, src.platform, src.code, src.product, number ? number.id : null, ts, nowIso(), nowIso()).run();
    contact = await env.DB.prepare("SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?").bind(ev.waId).first();
  }
  if (!contact) return;

  const out = ev.direction === 'out';
  const ins = await env.DB.prepare(
    'INSERT INTO messages (contact_id, direction, number_id, ext_msg_id, type, body, media_id, media_url, media_mime, caption, status, from_app, ts, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ext_msg_id) DO NOTHING'
  ).bind(contact.id, ev.direction, number ? number.id : null, msg.id || null, msg.type, msg.body || '', msg.mediaId || '', msg.mediaUrl || '', msg.mime || '',
    msg.caption || '', out ? 'sent' : 'received', out ? 1 : 0, ts, nowIso()).run();
  if (!ins.meta.changes) return;

  const preview = previewOf(msg, ev.direction);
  await env.DB.prepare(
    'UPDATE contacts SET ' +
    "name = CASE WHEN name = '' THEN ?1 ELSE name END, " +
    "first_message_at = CASE WHEN first_message_at = '' OR ?2 < first_message_at THEN ?2 ELSE first_message_at END, " +
    'last_message_at = CASE WHEN ?2 >= last_message_at THEN ?2 ELSE last_message_at END, ' +
    'last_preview = CASE WHEN ?2 >= last_message_at THEN ?3 ELSE last_preview END, ' +
    "last_inbound_at = CASE WHEN ?4 = 'in' AND ?2 > last_inbound_at THEN ?2 ELSE last_inbound_at END, " +
    'unread = unread + ?5, ' +
    'number_id = CASE WHEN ?6 = 1 AND ?7 IS NOT NULL THEN ?7 ELSE COALESCE(number_id, ?7) END, ' +
    'updated_at = ?8 WHERE id = ?9'
  ).bind(ev.profileName || '', ts, preview, ev.direction, live ? 1 : 0, live ? 1 : 0, number ? number.id : null, nowIso(), contact.id).run();
}

async function whatsappHook(req, env, url) {
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode'), tok = url.searchParams.get('hub.verify_token'), ch = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && ch != null && tok && env.WA_VERIFY_TOKEN && await safeEqual(tok, env.WA_VERIFY_TOKEN)) {
      return new Response(ch, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    fail(403, 'Нет доступа');
  }
  if (req.method !== 'POST') fail(405, 'Метод не поддерживается');
  if (!env.WA_APP_SECRET) fail(503, 'WhatsApp ещё не подключён');
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_HOOK_BODY) fail(413, 'Слишком большой запрос');
  const sig = (req.headers.get('X-Hub-Signature-256') || '').trim().toLowerCase();
  const expected = 'sha256=' + await hmacHex(env.WA_APP_SECRET, raw);
  if (!sig || !(await safeEqual(sig, expected))) fail(401, 'Нет доступа');
  let data;
  try { data = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { fail(400, 'Некорректный запрос'); }
  await ingestEvents(env, parseWebhook(data), 'cloud');
  return json({ ok: true });
}

// The one ingest path for every connector (Cloud API webhook, QR connector via /api/hooks/inbox).
// A non-2xx answer makes the sender retry; inserts are idempotent (ext_msg_id), so a retry is safe.
async function ingestEvents(env, events, connection) {
  if (!events.length) return 0;
  const { results: targets } = await env.DB.prepare('SELECT * FROM target_texts WHERE active = 1').all();
  const ctx = { targets: targets || [], numbers: new Map(), connection };
  let failed = 0;
  for (const ev of events) {
    try { await processWaEvent(env, ctx, ev); }
    catch (e) { failed++; console.error('whatsapp event failed:', e && e.message ? String(e.message).slice(0, 150) : 'unknown'); }
  }
  if (failed) fail(500, 'Не удалось сохранить часть сообщений');
  return events.length;
}

// POST /api/hooks/inbox (X-Api-Key): normalized events from a linked-device connector.
async function inboxHook(env, b) {
  const n = await ingestEvents(env, normalizeInboxEvents(b), 'qr');
  return json({ ok: true, accepted: n });
}

/* ----- row mappers ----- */
function numberOut(r, admin) {
  return {
    id: r.id, phone: r.phone, label: r.label, phoneNumberId: admin ? (r.phone_number_id || '') : '', status: r.status,
    connection: r.connection || '', lastSeenAt: r.last_seen_at || '',
    isCurrent: !!r.is_current, note: r.note, createdAt: r.created_at
  };
}
function targetOut(r) {
  return {
    id: r.id, productName: r.product_name, code: r.code, text: r.text, active: !!r.active, clicks: r.clicks, note: r.note,
    contacts: r.contacts == null ? 0 : r.contacts
  };
}
function chatOut(r) {
  return {
    id: r.id, channel: r.channel, name: r.name, phone: r.phone, traffic: r.traffic, platform: r.platform, targetCode: r.target_code,
    productName: r.product_name, numberId: r.number_id, numberLabel: r.number_label || r.number_phone || '', numberStatus: r.number_status || '',
    lastAt: r.last_message_at, lastInboundAt: r.last_inbound_at, preview: r.last_preview, unread: r.unread,
    orderId: r.order_id == null ? null : r.order_id, orderNum: r.order_num == null ? null : r.order_num, manual: !!r.source_manual
  };
}
function messageOut(r) {
  return {
    id: r.id, direction: r.direction, type: r.type, body: r.body, caption: r.caption, hasMedia: !!(r.media_id || r.media_url), mime: r.media_mime,
    status: r.status, fromApp: !!r.from_app, ts: r.ts
  };
}

const CHAT_SELECT =
  'SELECT c.*, n.label AS number_label, n.phone AS number_phone, n.status AS number_status, o.num AS order_num ' +
  'FROM contacts c LEFT JOIN wa_numbers n ON n.id = c.number_id LEFT JOIN orders o ON o.id = c.order_id ';

async function uniqueOr409(promise, message) {
  try { return await promise; }
  catch (e) {
    if (e instanceof HttpError) throw e;
    if (/UNIQUE|constraint/i.test(String(e && e.message))) fail(409, message);
    throw e;
  }
}
const cleanPhone = (v) => {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);   // 8 701 ... -> 7 701 ...
  if (d.length < 8 || d.length > 15) fail(400, 'Номер укажите в международном формате, например 77011234567');
  return d;
};

async function loadChat(env, idStr) {
  const id = parseInt(idStr, 10);
  const c = id > 0 ? await env.DB.prepare(CHAT_SELECT + 'WHERE c.id = ?').bind(id).first() : null;
  if (!c) fail(404, 'Чат не найден');
  return c;
}

// How a message leaves through this number: Cloud API (phone_number_id + WA_TOKEN), else the QR connector (CONNECTOR_URL), else none.
function sendRoute(env, num) {
  if (num.phone_number_id && env.WA_TOKEN) return 'cloud';
  if (env.CONNECTOR_URL) return 'connector';
  return null;
}
// Returns the provider message id ('' if unknown). Throws HttpError with a Russian message on failure.
async function sendVia(env, route, num, payload) {
  let resp, data = null;
  try {
    if (route === 'cloud') {
      resp = await fetch(`${WA_GRAPH}/${encodeURIComponent(num.phone_number_id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: 'text', text: { preview_url: false, body: payload.text } })
      });
    } else {
      resp = await fetch(`${String(env.CONNECTOR_URL).replace(/\/+$/, '')}/send`, {
        method: 'POST',
        headers: { 'X-Api-Key': env.CONNECTOR_KEY || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ numberPhone: num.phone, to: payload.to, type: payload.type, text: payload.text })
      });
    }
    data = await resp.json().catch(() => null);
  } catch (e) { fail(502, 'Нет связи с WhatsApp. Попробуйте ещё раз.'); }
  if (!resp.ok) {
    const code = data && data.error && typeof data.error === 'object' ? data.error.code : 0;
    if (code === 131047) fail(409, 'Прошло больше 24 часов с последнего сообщения клиента: WhatsApp не даёт отправить обычное сообщение.', { code: 'window' });
    const em = data && data.error ? (typeof data.error === 'string' ? data.error : data.error.message) : '';
    fail(502, 'WhatsApp не принял сообщение.' + (em ? ' ' + String(em).slice(0, 200) : ''));
  }
  if (route === 'cloud') return data && data.messages && data.messages[0] ? String(data.messages[0].id || '') : '';
  return data && (data.id || data.messageId) ? String(data.id || data.messageId) : '';
}

async function sendChatMessage(env, user, idStr, b) {
  const c = await loadChat(env, idStr);
  if (c.channel !== 'whatsapp') fail(400, 'Ответ в этом канале пока не поддерживается');
  const text = str(b.text, 4096, 'Сообщение');
  if (!text) fail(400, 'Введите сообщение');
  const num = c.number_id ? await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(c.number_id).first() : null;
  if (!num) fail(409, 'Не известно, на какой номер писал клиент. Ответьте из приложения WhatsApp на телефоне.');
  if (num.status === 'blocked') {
    fail(409, `Номер ${num.label || num.phone} заблокирован — с него ответить нельзя. Ответьте клиенту из приложения WhatsApp или с запасного номера.`, { code: 'blocked' });
  }
  if (num.status === 'off') fail(409, `Номер ${num.label || num.phone} выключен в настройках — с него ответить нельзя.`, { code: 'off' });
  const route = sendRoute(env, num);
  if (!route) fail(503, 'Номер не подключён');
  const last = Date.parse(c.last_inbound_at || '');
  if (route === 'cloud' && b.force !== true && (!last || Date.now() - last > WA_WINDOW_MS)) {
    fail(409, 'Прошло больше 24 часов с последнего сообщения клиента: WhatsApp не даёт отправить обычное сообщение. Напишите клиенту из приложения на телефоне или отправьте шаблон.', { code: 'window' });
  }
  const extId = await sendVia(env, route, num, { to: c.ext_id, type: 'text', text });
  const ts = nowIso();
  const ins = await env.DB.prepare(
    "INSERT INTO messages (contact_id, direction, number_id, ext_msg_id, type, body, status, from_app, ts, created_at) VALUES (?, 'out', ?, ?, 'text', ?, 'sent', 0, ?, ?) " +
    'ON CONFLICT(ext_msg_id) DO NOTHING'
  ).bind(c.id, num.id, extId || null, text, ts, ts).run();
  await env.DB.batch([
    env.DB.prepare('UPDATE contacts SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?')
      .bind(ts, previewOf({ type: 'text', body: text }, 'out'), ts, c.id),
    auditStmt(env, user.email, 'chat-send', null, null, `chat#${c.id}`)
  ]);
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(ins.meta.last_row_id).first();
  return json({ ok: true, message: row ? messageOut(row) : null });
}

async function setChatSource(env, user, idStr, b) {
  const c = await loadChat(env, idStr);
  const traffic = str(b.traffic, 20, 'Источник');
  if (!TRAFFIC.includes(traffic)) fail(400, 'Источник: таргет, органика или старый клиент');
  let code = '', product = '';
  if (traffic === 'target') {
    code = str(b.code, 20, 'Код');
    if (code) {
      const tg = await env.DB.prepare('SELECT code, product_name FROM target_texts WHERE code = ?').bind(code).first();
      if (!tg) fail(400, 'Такого кода нет в списке «Таргет — товары и тексты»');
      code = tg.code; product = tg.product_name;
    }
  }
  const stmts = [
    env.DB.prepare('UPDATE contacts SET traffic = ?, target_code = ?, product_name = ?, source_manual = 1, updated_at = ? WHERE id = ?')
      .bind(traffic, code, product, nowIso(), c.id),
    auditStmt(env, user.email, 'chat-source', null, null, `chat#${c.id} ${traffic}${code ? ' ' + code : ''}`)
  ];
  if (c.order_id) {
    stmts.push(env.DB.prepare('UPDATE orders SET traffic = ?, target_code = ?, updated_at = ? WHERE id = ?')
      .bind(traffic === 'old' ? '' : traffic, code, nowIso(), c.order_id));
  }
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function orderFromChat(env, user, idStr) {
  const c = await loadChat(env, idStr);
  if (c.order_id) {
    const ex = await env.DB.prepare('SELECT id, num FROM orders WHERE id = ?').bind(c.order_id).first();
    if (ex) return json({ ok: true, existing: true, id: String(ex.id), num: ex.num });
  }
  const { results } = await env.DB.prepare(
    "SELECT body, caption FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY ts DESC, id DESC LIMIT 10"
  ).bind(c.id).all();
  const lastText = ((results || []).map((m) => m.body || m.caption).find(Boolean) || '').slice(0, 1000);
  const b = {
    name: c.name, phone: c.phone ? '+' + c.phone : '', source: 'WhatsApp', comment: lastText,
    traffic: c.traffic === 'old' ? '' : c.traffic, targetCode: c.target_code
  };
  if (c.product_name) {
    const { results: prods } = await env.DB.prepare('SELECT id, name FROM products WHERE active = 1').all();
    const want = c.product_name.trim().toLowerCase();
    const p = (prods || []).find((x) => String(x.name).trim().toLowerCase() === want);
    if (p) b.productId = p.id; else b.productName = c.product_name;
  }
  const row = await createOrder(env, user, b);
  await env.DB.prepare('UPDATE contacts SET order_id = ?, updated_at = ? WHERE id = ?').bind(row.id, nowIso(), c.id).run();
  return json({ ok: true, id: String(row.id), num: row.num }, 201);
}

// Streams a message attachment from the Cloud API. The whole file is buffered (WhatsApp limits it to 16 MB) so that
// Range requests, which Safari needs for audio and video, can be answered.
async function mediaProxy(req, env, idStr) {
  const id = parseInt(idStr, 10);
  const m = id > 0 ? await env.DB.prepare('SELECT media_id, media_url, media_mime FROM messages WHERE id = ?').bind(id).first() : null;
  if (!m || (!m.media_id && !m.media_url)) fail(404, 'Файл не найден');
  let meta, buf;
  if (m.media_url) {
    // Connector-hosted file: only hosts listed in CONNECTOR_MEDIA_HOSTS (comma separated) may be fetched.
    let host = '';
    try { host = new URL(m.media_url).host.toLowerCase(); } catch (e) { host = ''; }
    const allowed = String(env.CONNECTOR_MEDIA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!host || !allowed.includes(host)) fail(400, 'Адрес вложения не разрешён (CONNECTOR_MEDIA_HOSTS)');
    try {
      const r = await fetch(m.media_url, { headers: env.CONNECTOR_KEY ? { 'X-Api-Key': env.CONNECTOR_KEY } : {} });
      if (!r.ok) fail(502, 'Файл недоступен');
      buf = await r.arrayBuffer();
      meta = { mime_type: r.headers.get('Content-Type') || '' };
    } catch (e) { if (e instanceof HttpError) throw e; fail(502, 'Нет связи с коннектором'); }
  } else {
    if (!env.WA_TOKEN) fail(503, 'WhatsApp ещё не подключён');
    try {
      const r1 = await fetch(`${WA_GRAPH}/${encodeURIComponent(m.media_id)}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      if (!r1.ok) fail(502, 'Файл недоступен (WhatsApp хранит вложения ограниченное время)');
      meta = await r1.json();
    } catch (e) { if (e instanceof HttpError) throw e; fail(502, 'Нет связи с WhatsApp'); }
    if (!meta || typeof meta.url !== 'string' || !/^https:\/\//i.test(meta.url)) fail(502, 'Файл недоступен');
    try {
      const r2 = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
      if (!r2.ok) fail(502, 'Файл недоступен');
      buf = await r2.arrayBuffer();
    } catch (e) { if (e instanceof HttpError) throw e; fail(502, 'Нет связи с WhatsApp'); }
  }
  let ct = String(meta.mime_type || m.media_mime || '').split(';')[0].trim().toLowerCase();
  const safe = MEDIA_TYPES.test(ct);
  if (!safe) ct = 'application/octet-stream';
  const headers = { 'Content-Type': ct, 'Accept-Ranges': 'bytes' };
  if (!safe) headers['Content-Disposition'] = 'attachment';
  const size = buf.byteLength;
  const rm = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (rm && (rm[1] || rm[2])) {
    let start = rm[1] ? parseInt(rm[1], 10) : Math.max(0, size - parseInt(rm[2], 10));
    let end = rm[1] && rm[2] ? Math.min(parseInt(rm[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(buf.slice(start, end + 1), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(buf, { status: 200, headers });
}

async function listChats(env, url) {
  if (url.searchParams.get('count')) {
    const r = await env.DB.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM contacts').first();
    return json({ unreadTotal: r ? r.n : 0 });
  }
  const filter = url.searchParams.get('filter') || '';
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const where = [];
  if (filter === 'unread') where.push('c.unread > 0');
  else if (filter === 'target') where.push("c.traffic = 'target'");
  else if (filter === 'organic') where.push("c.traffic = 'organic'");
  const { results } = await env.DB.prepare(
    CHAT_SELECT + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY c.last_message_at DESC, c.id DESC LIMIT ' + (q ? 2000 : 300)
  ).all();
  let rows = results || [];
  if (q) {
    // SQLite LIKE is not case-insensitive for Cyrillic, so the search runs here.
    const qd = q.replace(/\D/g, '');
    rows = rows.filter((r) => {
      const hay = [r.name, r.last_preview, r.product_name, r.target_code, r.number_label].join(' ').toLowerCase();
      return hay.includes(q) || (qd.length >= 3 && String(r.phone).includes(qd));
    }).slice(0, 300);
  }
  const tot = await env.DB.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM contacts').first();
  return json({ chats: rows.map(chatOut), unreadTotal: tot ? tot.n : 0 });
}

async function openChat(env, idStr) {
  const c = await loadChat(env, idStr);
  const { results } = await env.DB.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY ts DESC, id DESC LIMIT 500').bind(c.id).all();
  if (c.unread) await env.DB.prepare('UPDATE contacts SET unread = 0 WHERE id = ?').bind(c.id).run();
  c.unread = 0;
  return json({ chat: chatOut(c), messages: (results || []).reverse().map(messageOut) });
}

/* ----- numbers and targets ----- */
async function numbersApi(req, env, user, p, m) {
  const admin = user.role === 'admin';
  let mt;
  if (p === '/api/wa-numbers') {
    if (m === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM wa_numbers ORDER BY id').all();
      return json({ numbers: (results || []).map((r) => numberOut(r, admin)) });
    }
    if (m === 'POST') {
      requireAdmin(user);
      const b = await readJson(req);
      const phone = cleanPhone(b.phone);
      const label = str(b.label, 60, 'Подпись');
      const status = b.status === undefined ? 'active' : str(b.status, 10, 'Статус');
      if (!NUMBER_STATUSES.includes(status)) fail(400, 'Неизвестный статус номера');
      const pnid = str(b.phoneNumberId, 40, 'Phone Number ID');
      const ts = nowIso();
      // The very first number becomes the current one, so that the links work right away.
      const any = await env.DB.prepare('SELECT COUNT(*) AS n FROM wa_numbers WHERE is_current = 1').first();
      const cur = !any.n && status === 'active' ? 1 : 0;
      const r = await uniqueOr409(env.DB.prepare(
        'INSERT INTO wa_numbers (phone, label, phone_number_id, status, is_current, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(phone, label, pnid || null, status, cur, str(b.note, 300, 'Заметка'), ts, ts).run(), 'Такой номер или Phone Number ID уже есть');
      await auditStmt(env, user.email, 'wa-number-add', null, null, `number#${r.meta.last_row_id}`).run();
      return json({ ok: true, id: r.meta.last_row_id }, 201);
    }
  }
  if ((mt = p.match(/^\/api\/wa-numbers\/(\d+)$/))) {
    const id = parseInt(mt[1], 10);
    if (m === 'PATCH') {
      requireAdmin(user);
      const cur = await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(id).first();
      if (!cur) fail(404, 'Номер не найден');
      const b = await readJson(req);
      const set = {};
      if ('phone' in b) set.phone = cleanPhone(b.phone);
      if ('label' in b) set.label = str(b.label, 60, 'Подпись');
      if ('note' in b) set.note = str(b.note, 300, 'Заметка');
      if ('phoneNumberId' in b) set.phone_number_id = str(b.phoneNumberId, 40, 'Phone Number ID') || null;
      if ('status' in b) {
        set.status = str(b.status, 10, 'Статус');
        if (!NUMBER_STATUSES.includes(set.status)) fail(400, 'Неизвестный статус номера');
      }
      const names = Object.keys(set);
      if (!names.length) return json({ ok: true });
      set.updated_at = nowIso();
      const keys = Object.keys(set);
      await uniqueOr409(env.DB.batch([
        env.DB.prepare(`UPDATE wa_numbers SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => set[k]), id),
        auditStmt(env, user.email, 'wa-number-edit', null, null, `number#${id} ${names.join(',')}`)
      ]), 'Такой номер или Phone Number ID уже есть');
      // Tell the page when the number that all links point to stopped being usable.
      return json({ ok: true, linksBroken: !!(cur.is_current && set.status && set.status !== 'active') });
    }
    if (m === 'DELETE') {
      requireAdmin(user);
      const cur = await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(id).first();
      if (!cur) fail(404, 'Номер не найден');
      if (cur.is_current) fail(409, 'Сначала выберите другой номер для ссылок');
      const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM contacts WHERE number_id = ?1) + (SELECT COUNT(*) FROM messages WHERE number_id = ?1) AS n').bind(id).first();
      if (used.n) fail(409, 'По этому номеру есть переписка — удалить нельзя. Отметьте номер «выключен».');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM wa_numbers WHERE id = ?').bind(id),
        auditStmt(env, user.email, 'wa-number-del', null, null, `number#${id}`)
      ]);
      return json({ ok: true });
    }
  }
  if ((mt = p.match(/^\/api\/wa-numbers\/(\d+)\/current$/)) && m === 'POST') {
    requireAdmin(user);
    const id = parseInt(mt[1], 10);
    const n = await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(id).first();
    if (!n) fail(404, 'Номер не найден');
    if (n.status !== 'active') fail(409, 'Ссылки нельзя направить на заблокированный или выключенный номер');
    const ts = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE wa_numbers SET is_current = 0, updated_at = ? WHERE is_current = 1 AND id != ?').bind(ts, id),
      env.DB.prepare('UPDATE wa_numbers SET is_current = 1, updated_at = ? WHERE id = ?').bind(ts, id),
      auditStmt(env, user.email, 'wa-current', null, null, `number#${id}`)
    ]);
    return json({ ok: true });
  }
  return null;
}

const TARGET_SELECT =
  'SELECT t.*, (SELECT COUNT(*) FROM contacts c WHERE t.code = c.target_code) AS contacts FROM target_texts t ';

function cleanTargetCode(v) {
  const code = str(v, 12, 'Код');
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(code)) fail(400, 'Код: до 12 латинских букв и цифр, например A3');
  return code;
}

async function targetsApi(req, env, user, p, m) {
  let mt;
  if (p === '/api/targets') {
    if (m === 'GET') {
      const { results } = await env.DB.prepare(TARGET_SELECT + 'ORDER BY t.id').all();
      return json({ targets: (results || []).map(targetOut) });
    }
    if (m === 'POST') {
      requireAdmin(user);
      const b = await readJson(req);
      const code = cleanTargetCode(b.code);
      const text = str(b.text, 1000, 'Текст сообщения');
      if (!text) fail(400, 'Введите текст сообщения');
      const ts = nowIso();
      const r = await uniqueOr409(env.DB.prepare(
        'INSERT INTO target_texts (product_name, code, text, active, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(str(b.productName, 200, 'Товар'), code, text, b.active === false ? 0 : 1, str(b.note, 300, 'Заметка'), ts, ts).run(), 'Такой код уже есть');
      await auditStmt(env, user.email, 'target-add', null, null, `target#${r.meta.last_row_id} ${code}`).run();
      return json({ ok: true, id: r.meta.last_row_id }, 201);
    }
  }
  if ((mt = p.match(/^\/api\/targets\/(\d+)$/))) {
    const id = parseInt(mt[1], 10);
    if (m === 'PATCH') {
      requireAdmin(user);
      const b = await readJson(req);
      const set = {};
      if ('productName' in b) set.product_name = str(b.productName, 200, 'Товар');
      if ('code' in b) set.code = cleanTargetCode(b.code);
      if ('text' in b) { set.text = str(b.text, 1000, 'Текст сообщения'); if (!set.text) fail(400, 'Введите текст сообщения'); }
      if ('active' in b) set.active = b.active ? 1 : 0;
      if ('note' in b) set.note = str(b.note, 300, 'Заметка');
      const names = Object.keys(set);
      if (!names.length) return json({ ok: true });
      set.updated_at = nowIso();
      const keys = Object.keys(set);
      const res = await uniqueOr409(env.DB.batch([
        env.DB.prepare(`UPDATE target_texts SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => set[k]), id),
        auditStmt(env, user.email, 'target-edit', null, null, `target#${id} ${names.join(',')}`)
      ]), 'Такой код уже есть');
      if (!res[0].meta.changes) fail(404, 'Текст не найден');
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      requireAdmin(user);
      const res = await env.DB.batch([
        env.DB.prepare('DELETE FROM target_texts WHERE id = ?').bind(id),
        auditStmt(env, user.email, 'target-del', null, null, `target#${id}`)
      ]);
      if (!res[0].meta.changes) fail(404, 'Текст не найден');
      return json({ ok: true });
    }
  }
  return null;
}

// Session-auth part of the inbox API; returns null when the path is not an inbox path.
async function inboxApi(req, env, url, user) {
  const p = url.pathname, m = req.method;
  let mt;
  if (p === '/api/chats' && m === 'GET') return listChats(env, url);
  if ((mt = p.match(/^\/api\/chats\/(\d+)$/)) && m === 'GET') return openChat(env, mt[1]);
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/send$/)) && m === 'POST') return sendChatMessage(env, user, mt[1], await readJson(req));
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/source$/)) && m === 'POST') return setChatSource(env, user, mt[1], await readJson(req));
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/order$/)) && m === 'POST') return orderFromChat(env, user, mt[1]);
  if ((mt = p.match(/^\/api\/media\/(\d+)$/)) && m === 'GET') return mediaProxy(req, env, mt[1]);
  if (p === '/api/wa-numbers' || p.startsWith('/api/wa-numbers/')) return numbersApi(req, env, user, p, m);
  if (p === '/api/targets' || p.startsWith('/api/targets/')) return targetsApi(req, env, user, p, m);
  return null;
}

/* ----- public links: /wa and /wa/<code> ----- */
function unavailablePage() {
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Номер временно недоступен</title><link rel="stylesheet" href="/app.css"></head>' +
    '<body><main class="wrap"><div class="card"><div class="h1">Номер временно недоступен</div>' +
    '<p>Мы уже работаем над этим. Пожалуйста, попробуйте написать нам чуть позже.</p></div></main></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '300' } });
}
async function waLink(env, code, count) {
  const cur = await env.DB.prepare('SELECT phone FROM wa_numbers WHERE is_current = 1').first();
  if (!cur) return unavailablePage();
  let target = null;
  if (code) {
    target = await env.DB.prepare('SELECT id, text FROM target_texts WHERE code = ? AND active = 1').bind(code).first();
    if (target && count) await env.DB.prepare('UPDATE target_texts SET clicks = clicks + 1 WHERE id = ?').bind(target.id).run();
  }
  const to = `https://wa.me/${cur.phone}` + (target && target.text ? `?text=${encodeURIComponent(target.text)}` : '');
  return new Response(null, { status: 302, headers: { Location: to } });
}

/* ---------- punctual autopublishing ----------
   GitHub starts its own scheduled runs 10-40 min late, so a Cloudflare cron (wrangler.toml [triggers]) checks every
   5 minutes whether an approved slot is due and still waiting, and if so starts the publish workflow right away.
   GitHub's schedule stays as the backup; publish.yml runs one at a time and never posts a done slot twice. */
const MORNING_CRON = '0 4 * * *'; // must match wrangler.toml [triggers]
const EVENING_CRON = '0 17 * * *'; // 22:00 Almaty; GitHub's own schedule ran 3.5 h late on 2026-10-31

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

// 09:00 / 22:00 Almaty: start the morning / evening report workflow (each script sends at most once per day).
async function startReport(env, workflow) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bikas-crm', 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: env.GH_DISPATCH_REF || 'claude/ai-ecommerce-automation-3n1lgz' })
  });
  if (resp.status !== 204) console.error(workflow + ' dispatch failed:', resp.status);
}

export default {
  async scheduled(event, env, ctx) {
    const job = event.cron === MORNING_CRON ? startReport(env, 'morning.yml')
      : event.cron === EVENING_CRON ? startReport(env, 'evening.yml') : autoPublish(env);
    ctx.waitUntil(job);
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
    // Public click-to-WhatsApp links for ads and landing pages: they follow the number marked as current.
    const wl = url.pathname.match(/^\/wa(?:\/([A-Za-z0-9_-]{1,12}))?\/?$/);
    if (wl) {
      try { return secure(await waLink(env, wl[1] || '', req.method === 'GET'), { api: true }); }
      catch (e) { console.error('wa link error'); return secure(unavailablePage(), { api: true }); }
    }
    return secure(await env.ASSETS.fetch(req));
  }
};

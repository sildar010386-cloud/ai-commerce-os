// Bikas CRM: Cloudflare Worker (REST API under /api/*) + static UI from ./public + D1 (SQLite).
// Plain JS, no framework, no build step. All SQL is parameterized (prepare/bind).
// User-facing messages are in Russian. Client names and phones are never logged.

import { detectSource } from './source.js';
import { parseWebhook, normalizeInboxEvents } from './wa.js';
import { CLOUD_INIT_TEMPLATE } from './connector_script.js';
import { WINDOWS_SETUP_TEMPLATE } from './connector_windows.js';
import { fetchNbkUsd, fetchErApiUsd } from './fx.js';

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
const SETTINGS_KEYS = ['wa1', 'wa2', 'payLink', 'templates', 'track_msg', 'track_url', 'usd_manual'];
const MANAGER_SETTINGS = ['wa1', 'wa2', 'payLink', 'track_msg', 'track_url'];
// Shown (and used) while the owner has not changed them in Настройки. Placeholders: {имя} {трек} {ссылка}; {трек} in the URL.
const DEFAULT_TRACK_MSG = 'Здравствуйте, {имя}! Ваш заказ отправлен Казпочтой. Трек-номер: {трек}. ' +
  'Где сейчас посылка — по ссылке: {ссылка} Спасибо за покупку!';
const DEFAULT_TRACK_URL = 'https://post.kz/services/postal/{трек}';
const SETTING_DEFAULTS = { track_msg: DEFAULT_TRACK_MSG, track_url: DEFAULT_TRACK_URL };
const TRACK_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const KZ_MAX_ITEMS = 500;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
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
  h.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
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
async function readJson(req, max) {
  const text = await req.text();
  if (text.length > (max || MAX_BODY)) fail(413, 'Слишком большой запрос');
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
function orderOut(r, items) {
  const its = (items || []).map((i) => ({ id: i.id, productId: i.product_id, productName: i.product_name, qty: i.qty, sum: i.sum }));
  return {
    id: String(r.id), num: r.num, status: r.status, name: r.name, phone: r.phone, city: r.city, address: r.address,
    productId: r.product_id, productName: r.product_name, qty: r.qty, sum: r.sum, source: r.source, post: r.post,
    comment: r.comment, delivery: r.delivery, track: r.track, remindAt: r.remind_at, reserveNote: r.reserve_note,
    cancelNote: r.cancel_note, example: !!r.example, stockDeducted: !!r.stock_deducted, trackSentAt: r.track_sent_at || '',
    traffic: r.traffic || '', targetCode: r.target_code || '',
    promo: r.promo || '', paidQty: r.paid_qty || r.qty, giftQty: r.gift_qty || 0,
    isRepeat: !!r.is_repeat, items: its, total: r.sum + its.reduce((t, i) => t + i.sum, 0),
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
const PROMOS = ['', '1+1', '2+1'];
// Gift units for a promotion: 1+1 gives as many as were paid, 2+1 gives one per two paid.
function giftFor(promo, paid) {
  if (promo === '1+1') return paid;
  if (promo === '2+1') return Math.floor(paid / 2);
  return 0;
}
// Works out promo / paid_qty / gift_qty / qty (qty = shipped total = paid + gift) from the request `b` and the current row `cur`
// (null on create). Returns {} when the request touches none of promo / paidQty / qty.
// With a promotion the client's qty is ignored (the server owns the arithmetic); without one qty can be edited directly and paid = qty.
function resolveQty(cur, b) {
  const hasPromo = 'promo' in b, hasPaid = 'paidQty' in b, hasQty = 'qty' in b;
  if (!hasPromo && !hasPaid && !hasQty) return {};
  let promo = cur ? cur.promo || '' : '';
  if (hasPromo) {
    promo = b.promo == null ? '' : b.promo;
    if (typeof promo !== 'string' || !PROMOS.includes(promo)) fail(400, 'Акция: «1+1», «2+1» или без акции');
  }
  const paidIn = hasPaid ? numIn(b.paidQty, 1, 10000, 'Оплачено, шт.', true) : null;
  const qtyIn = hasQty ? numIn(b.qty, 1, 10000, 'Количество', true) : null;
  const curPaid = cur ? cur.paid_qty || cur.qty || 1 : 1;
  let paid, gift, qty;
  if (promo) {
    paid = paidIn != null ? paidIn : curPaid;
    gift = giftFor(promo, paid);
    qty = paid + gift;
    if (qty > 10000) fail(400, 'Количество слишком большое');
  } else {
    qty = qtyIn != null ? qtyIn : paidIn != null ? paidIn : curPaid;
    paid = qty; gift = 0;
  }
  return { promo, paid_qty: paid, gift_qty: gift, qty };
}
const ORDER_COLS = {
  name: 'name', phone: 'phone', city: 'city', address: 'address', productId: 'product_id', productName: 'product_name',
  qty: 'qty', sum: 'sum', source: 'source', post: 'post', comment: 'comment', delivery: 'delivery', track: 'track',
  remindAt: 'remind_at', reserveNote: 'reserve_note', cancelNote: 'cancel_note', traffic: 'traffic', targetCode: 'target_code', isRepeat: 'is_repeat'
};
// Validates the order fields present in `b`; returns {col: value} (DB column names).
async function cleanOrderFields(env, b, cur) {
  const f = {};
  if ('name' in b) f.name = str(b.name, 200, 'Имя');
  if ('phone' in b) f.phone = str(b.phone, 40, 'Телефон');
  if ('city' in b) f.city = str(b.city, 120, 'Город');
  if ('address' in b) f.address = str(b.address, 400, 'Адрес');
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
  if ('isRepeat' in b) f.isRepeat = b.isRepeat ? 1 : 0;
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
  Object.assign(out, resolveQty(cur || null, b));
  return out;
}
function validateStatusFields(prevStatus, status, merged, touched) {
  if (status === 'reserve' && !isDate(merged.remind_at)) fail(400, 'Для резерва укажите дату «Напомнить»');
  if (status === 'sent' && (prevStatus !== 'sent' || touched.delivery || touched.track)) {
    if (!DELIVERY.includes(merged.delivery)) fail(400, 'Для отправки выберите службу доставки');
    if (merged.delivery !== 'Курьер' && !merged.track) fail(400, 'Для отправки впишите трек-номер');
  }
}

// Owner's own cost lines of a product: [{name, amount, per: 'unit' | 'parcel'}], up to 20.
function cleanExtras(v) {
  if (!Array.isArray(v)) fail(400, 'Иные расходы: нужен список');
  if (v.length > 20) fail(400, 'Иных расходов не больше 20');
  return v.map((x) => {
    if (!x || typeof x !== 'object') fail(400, 'Иные расходы указаны неверно');
    const name = str(x.name, 40, 'Название расхода');
    if (!name) fail(400, 'Впишите название расхода');
    if (x.per !== 'unit' && x.per !== 'parcel') fail(400, 'Расход: «на штуку» или «на посылку»');
    return { name, amount: numIn(x.amount == null ? 0 : x.amount, 0, 1e7, 'Сумма расхода', false), per: x.per };
  });
}

async function listOrders(env) {
  const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY num DESC LIMIT 5000').all();
  const { results: items } = await env.DB.prepare('SELECT * FROM order_items ORDER BY id').all();
  const by = {};
  (items || []).forEach((i) => { (by[i.order_id] = by[i.order_id] || []).push(i); });
  return results.map((r) => orderOut(r, by[r.id]));
}

/* ---------- upsell: extra product lines (order_items) ---------- */
const MAX_ITEMS = 5;
// Validates b.items ([{productId, qty, sum}]); null when the request does not touch them. `keep` = product ids already on the order (may be inactive now).
async function cleanItems(env, b, keep) {
  if (!('items' in b)) return null;
  if (b.items == null) return [];
  if (!Array.isArray(b.items)) fail(400, 'Допродажа: нужен список товаров');
  if (b.items.length > MAX_ITEMS) fail(400, 'Допродажа: не больше ' + MAX_ITEMS + ' товаров');
  if (!b.items.length) return [];
  const { results } = await env.DB.prepare('SELECT id, name, active FROM products').all();
  return b.items.map((x) => {
    if (!x || typeof x !== 'object') fail(400, 'Допродажа: строка указана неверно');
    const pid = str(x.productId, 64, 'Товар');
    const p = (results || []).find((r) => r.id === pid);
    if (!p) fail(400, 'Допродажа: товар не найден');
    if (!p.active && !(keep && keep.includes(pid))) fail(400, 'Допродажа: товар «' + p.name + '» выключен');
    return {
      product_id: p.id, product_name: p.name,
      qty: numIn(x.qty == null ? 1 : x.qty, 1, 1000, 'Количество', true), sum: numIn(x.sum == null ? 0 : x.sum, 0, 1e9, 'Сумма', false)
    };
  });
}
function itemInsertStmts(env, orderId, items, ts) {
  return items.map((i) => env.DB.prepare('INSERT INTO order_items (order_id, product_id, product_name, qty, sum, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(orderId, i.product_id, i.product_name, i.qty, i.sum, ts));
}
// Deducts the upsell lines from stock together with the main line. Reads order_items when it runs (so it sees lines replaced earlier in the same batch)
// and, like the main line, only while the order is still marked as not deducted: lines added or changed after the shipment are NOT deducted again.
function itemStockStmt(env, orderId) {
  return env.DB.prepare(
    'UPDATE products SET stock = MAX(0, stock - COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND product_id = products.id), 0)) ' +
    'WHERE id IN (SELECT product_id FROM order_items WHERE order_id = ?1) AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND stock_deducted = 0)'
  ).bind(orderId);
}

/* ---------- repeat customers ---------- */
// Last 10 digits of a phone, same rule in SQL (migration 0010 backfill) and here.
const phoneKeySql = (c) => `substr(replace(replace(replace(replace(replace(replace(replace(${c}, ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -10)`;
const phoneKey = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
async function isRepeatPhone(env, phone) {
  const k = phoneKey(phone);
  if (!k) return 0;
  const r = await env.DB.prepare(`SELECT 1 AS x FROM orders WHERE status != 'cancel' AND ${phoneKeySql('phone')} = ? LIMIT 1`).bind(k).first();
  return r ? 1 : 0;
}

async function insertOrder(env, cols, actor, action, detail) {
  if (!('is_repeat' in cols)) cols.is_repeat = await isRepeatPhone(env, cols.phone);
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
  const items = await cleanItems(env, b, []);
  const status = b.status === undefined ? 'new' : b.status;
  if (!STATUSES.includes(status)) fail(400, 'Неизвестный статус');
  const cols = Object.assign({
    name: '', phone: '', city: '', address: '', qty: 1, promo: '', paid_qty: 1, gift_qty: 0, sum: 0, source: 'Другое', post: '', comment: '',
    delivery: '', track: '', remind_at: '', reserve_note: '', cancel_note: '', product_id: '', product_name: ''
  }, f);
  if (!cols.name && !cols.phone) fail(400, 'Укажите имя или телефон');
  validateStatusFields('new', status, cols, { delivery: true, track: true });
  const ts = nowIso();
  // An order created straight as «Отправлен» is inserted as new and then moved, so the stock deduction runs once.
  cols.status = status === 'sent' ? 'new' : status; cols.created_at = ts; cols.updated_at = ts;
  const row = await insertOrder(env, cols, user.email, 'create', `status=${status}`);
  if (row && items && items.length) await env.DB.batch(itemInsertStmts(env, row.id, items, ts));
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
  const f = await cleanOrderFields(env, b, cur);
  const { results: curItems } = await env.DB.prepare('SELECT product_id, qty, sum FROM order_items WHERE order_id = ? ORDER BY id').bind(id).all();
  const newItems = await cleanItems(env, b, (curItems || []).map((i) => i.product_id));
  const sig = (a) => JSON.stringify((a || []).map((i) => [i.product_id, i.qty, i.sum]));
  const itemsChanged = newItems !== null && sig(newItems) !== sig(curItems);
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
  if (itemsChanged) {
    stmts.push(env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id), ...itemInsertStmts(env, id, newItems, nowIso()));
  }
  if (status === 'sent' && cur.status !== 'sent' && !cur.stock_deducted) {
    stmts.push(...stockDeductStmts(env, cur, merged.qty || 1), itemStockStmt(env, id));
    set.stock_deducted = 1;
  }
  if (changedFields.includes('track') && cur.track_sent_at) set.track_sent_at = ''; // a new track number has not been sent yet
  if (!Object.keys(set).length && !itemsChanged) return { changed: false };
  set.updated_at = nowIso();
  const names = Object.keys(set);
  stmts.push(env.DB.prepare(`UPDATE orders SET ${names.map((n) => n + ' = ?').join(', ')} WHERE id = ?`).bind(...names.map((n) => set[n]), id));
  if (status !== cur.status) stmts.push(auditStmt(env, user.email, 'status', id, cur.num, `${cur.status} -> ${status}`));
  const edited = changedFields.filter((k) => k !== 'status');
  if (itemsChanged) edited.push('items');
  if (edited.length && !internal) stmts.push(auditStmt(env, user.email, 'edit', id, cur.num, edited.join(',')));
  await env.DB.batch(stmts);
  return { changed: true };
}

async function deleteOrder(env, user, idStr) {
  const id = parseInt(idStr, 10);
  const cur = await env.DB.prepare('SELECT id, num FROM orders WHERE id = ?').bind(id).first();
  if (!cur) fail(404, 'Заказ не найден');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id),
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
    if (cur.status !== 'sent' && !cur.stock_deducted) { stmts.push(...stockDeductStmts(env, cur, cur.qty || 1), itemStockStmt(env, cur.id)); set.stock_deducted = 1; }
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

/* ---------- advertising costs ----------
   ad_campaigns (one per product cabinet) accrue one ad_spend row per Almaty day ('auto'); the owner can overwrite a day ('manual', never touched by accrual).
   USD rows are converted to tenge with that day's rate (fx_rates, National Bank of Kazakhstan; fallbacks in usdRates). Admin only. */
const AD_BACKFILL_DAYS = 400;   // accrual never goes further back than this
const FX_FETCH_PER_RUN = 12;    // NBK requests per accrual run (Workers allow 50 subrequests on the free plan)
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const almatyToday = () => isoDay(Date.now() + 5 * 3600000);
const addDays = (d, n) => isoDay(Date.parse(d + 'T00:00:00Z') + n * 86400000);
const money2 = (x) => Math.round(x * 100) / 100;
const AD_CURRENCIES = ['USD', 'KZT'];

function campaignOut(r) {
  return {
    id: r.id, productId: r.product_id, label: r.label, currency: r.currency, dailyAmount: r.daily_amount,
    startDate: r.start_date, endDate: r.end_date, active: !!r.active, createdAt: r.created_at, updatedAt: r.updated_at
  };
}
function spendOut(r) {
  return { campaignId: r.campaign_id, date: r.date, amountOrig: r.amount_orig, currency: r.currency, rate: r.rate, amountKzt: r.amount_kzt, source: r.source };
}

async function manualUsdRate(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'usd_manual'").first();
  const n = r ? parseFloat(String(r.value).replace(',', '.')) : 0;
  return n > 0 && isFinite(n) ? n : 0;
}

// Rate (KZT per 1 USD) for each date of `dates`: Map date -> {rate, source, date}. Order: manual setting (always wins) -> fx_rates row ->
// National Bank of Kazakhstan for that date (stored) -> open.er-api.com latest (stored only for today) -> latest known fx_rates row.
// A date stays out of the map when nothing worked. Network failures never throw.
async function usdRates(env, dates) {
  const out = new Map();
  const list = [...new Set(dates)].sort();
  if (!list.length) return out;
  const man = await manualUsdRate(env);
  if (man > 0) { list.forEach((d) => out.set(d, { rate: man, source: 'manual', date: d })); return out; }
  const { results } = await env.DB.prepare('SELECT date, usd_kzt, source FROM fx_rates WHERE date >= ? AND date <= ?').bind(list[0], list[list.length - 1]).all();
  (results || []).forEach((r) => { if (list.includes(r.date)) out.set(r.date, { rate: r.usd_kzt, source: r.source, date: r.date }); });
  const need = list.filter((d) => !out.has(d));
  if (!need.length) return out;
  const today = almatyToday(), ts = nowIso(), save = [];
  const got = await Promise.all(need.slice(-FX_FETCH_PER_RUN).map(async (d) => [d, await fetchNbkUsd(d)]));
  got.forEach(([d, rate]) => {
    if (!rate) return;
    out.set(d, { rate, source: 'nbk', date: d });
    save.push(env.DB.prepare('INSERT OR IGNORE INTO fx_rates (date, usd_kzt, source, fetched_at) VALUES (?, ?, ?, ?)').bind(d, rate, 'nbk', ts));
  });
  const rest = need.filter((d) => !out.has(d));
  if (rest.length) {
    let fallback = null;
    const er = await fetchErApiUsd();
    if (er) {
      fallback = { rate: er, source: 'erapi' };
      if (rest.includes(today)) save.push(env.DB.prepare('INSERT OR IGNORE INTO fx_rates (date, usd_kzt, source, fetched_at) VALUES (?, ?, ?, ?)').bind(today, er, 'erapi', ts));
    } else {
      const last = await env.DB.prepare('SELECT date, usd_kzt FROM fx_rates ORDER BY date DESC LIMIT 1').first();
      if (last) fallback = { rate: last.usd_kzt, source: 'last', date: last.date };
    }
    if (fallback) rest.forEach((d) => out.set(d, Object.assign({ date: d }, fallback)));
  }
  if (save.length) { try { await env.DB.batch(save); } catch (e) { console.error('fx save failed'); } }
  return out;
}

// Multi-row INSERT OR IGNORE with inlined, validated values (D1 allows only 100 bound parameters per statement).
function spendInsertStmts(env, rows, source) {
  const ts = nowIso(), out = [];
  const lit = (n) => { const x = Number(n); if (!Number.isFinite(x)) throw new Error('bad number'); return String(x); };
  for (let i = 0; i < rows.length; i += 100) {
    const vals = rows.slice(i, i + 100).map((r) => {
      if (!isDate(r.date) || !AD_CURRENCIES.includes(r.currency) || !Number.isInteger(r.campaignId)) throw new Error('bad ad row');
      return `(${r.campaignId}, '${r.date}', ${lit(r.amountOrig)}, '${r.currency}', ${lit(r.rate)}, ${lit(r.amountKzt)}, '${source}', '${ts}')`;
    });
    out.push(env.DB.prepare('INSERT OR IGNORE INTO ad_spend (campaign_id, date, amount_orig, currency, rate, amount_kzt, source, updated_at) VALUES ' + vals.join(', ')));
  }
  return out;
}

// Inserts the missing 'auto' ad_spend rows of every campaign up to min(today, upToDate) (and its end_date). Existing rows, manual ones included, are never touched.
// Every missing day from start_date (at most 400 days back) is filled. Skipped quietly when already done today unless opts.force;
// a run that lacked a USD rate clears the "done today" mark so the next read retries.
// Never throws: accrual problems are logged and the page keeps working.
async function ensureAccrued(env, upToDate, opts) {
  try { return await accrueAds(env, upToDate, opts || {}); } catch (e) { console.error('ads accrual failed'); return { ok: false, inserted: 0 }; }
}
async function accrueAds(env, upToDate, opts) {
  const today = almatyToday();
  const upTo = isDate(upToDate) && upToDate < today ? upToDate : today;
  if (!opts.force && upTo === today) {
    const done = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ads_accrued_on'").first();
    if (done && done.value === today) return { ok: true, skipped: true, inserted: 0 };
  }
  const { results: camps } = await env.DB.prepare('SELECT * FROM ad_campaigns').all();
  const floor = addDays(upTo, -(AD_BACKFILL_DAYS - 1));
  // Every day that has NO row yet is filled (not only the days after the latest row): a USD day skipped for want of a rate, or a
  // day before a manual edit, is accrued as soon as a rate is known. Existing rows (auto or manual) are never touched.
  const { results: haveRows } = await env.DB.prepare('SELECT campaign_id, date FROM ad_spend WHERE date >= ?').bind(floor).all();
  const have = new Set((haveRows || []).map((r) => r.campaign_id + '|' + r.date));
  const plan = [];
  for (const c of camps || []) {
    if (!c.active && !c.end_date) continue;
    const from = c.start_date > floor ? c.start_date : floor;
    const to = c.end_date && c.end_date < upTo ? c.end_date : upTo;
    if (from > to) continue;
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (!have.has(c.id + '|' + d)) days.push(d);
    if (days.length) plan.push({ c, days });
  }
  const usdDays = [];
  plan.forEach((p) => { if (p.c.currency === 'USD') usdDays.push(...p.days); });
  const rates = await usdRates(env, usdDays);
  const rows = [];
  let incomplete = false;
  for (const { c, days } of plan) {
    for (const d of days) {
      if (c.currency === 'KZT') { rows.push({ campaignId: c.id, date: d, amountOrig: c.daily_amount, currency: 'KZT', rate: 1, amountKzt: money2(c.daily_amount) }); continue; }
      const r = rates.get(d);
      if (!r) { incomplete = true; continue; } // no rate for this day yet: leave it empty and retry on the next call
      rows.push({ campaignId: c.id, date: d, amountOrig: c.daily_amount, currency: 'USD', rate: r.rate, amountKzt: money2(c.daily_amount * r.rate) });
    }
  }
  const stmts = spendInsertStmts(env, rows, 'auto');
  if (!incomplete && upTo === today) stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ads_accrued_on', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today));
  // Some USD days had no rate: forget "done today" so the next read retries (an earlier run today may have marked it).
  if (incomplete) stmts.push(env.DB.prepare("DELETE FROM settings WHERE key = 'ads_accrued_on'"));
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, inserted: rows.length, incomplete };
}

function dayRange(url, defDays) {
  const today = almatyToday();
  let to = url.searchParams.get('to') || today, from = url.searchParams.get('from') || addDays(to, -(defDays - 1));
  if (!isDate(from) || !isDate(to)) fail(400, 'Период указан неверно');
  if (from > to) fail(400, 'Начало периода позже конца');
  if (Date.parse(to) - Date.parse(from) > 400 * 86400000) fail(400, 'Период не длиннее 400 дней');
  return { from, to };
}

async function cleanCampaign(env, b, cur) {
  const f = {};
  if ('productId' in b) {
    const pid = str(b.productId, 64, 'Товар');
    const p = pid ? await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(pid).first() : null;
    if (!p) fail(400, 'Выберите товар');
    f.product_id = p.id;
  } else if (!cur) fail(400, 'Выберите товар');
  if ('label' in b) f.label = str(b.label, 60, 'Кабинет');
  if ('currency' in b) {
    if (!AD_CURRENCIES.includes(b.currency)) fail(400, 'Валюта: USD или KZT');
    f.currency = b.currency;
  }
  if ('dailyAmount' in b) f.daily_amount = numIn(b.dailyAmount, 0, 1e9, 'В день', false);
  if ('startDate' in b) { if (!isDate(b.startDate)) fail(400, 'Дата начала указана неверно'); f.start_date = b.startDate; }
  if ('endDate' in b) {
    const e = b.endDate == null ? '' : b.endDate;
    if (e !== '' && !isDate(e)) fail(400, 'Дата окончания указана неверно');
    f.end_date = e;
  }
  if ('active' in b) f.active = b.active ? 1 : 0;
  const start = f.start_date || (cur && cur.start_date), end = 'end_date' in f ? f.end_date : cur && cur.end_date;
  if (end && start && end < start) fail(400, 'Дата окончания раньше даты начала');
  return f;
}

async function adsApi(req, env, url, user) {
  const p = url.pathname, m = req.method;
  let mt;
  if (p === '/api/fx' && m === 'GET') {
    const today = almatyToday(), man = await manualUsdRate(env);
    const r = (await usdRates(env, [today])).get(today);
    return json({ date: today, rate: r ? r.rate : null, source: r ? r.source : '', rateDate: r ? r.date : '', manual: man > 0 });
  }
  if (p === '/api/ads/campaigns' && m === 'GET') {
    await ensureAccrued(env);
    const { results } = await env.DB.prepare('SELECT * FROM ad_campaigns ORDER BY product_id, id').all();
    return json({ campaigns: (results || []).map(campaignOut) });
  }
  if (p === '/api/ads/campaigns' && m === 'POST') {
    const b = await readJson(req);
    const f = await cleanCampaign(env, b, null);
    const ts = nowIso();
    const cols = Object.assign({ label: '', currency: 'USD', daily_amount: 0, start_date: almatyToday(), end_date: '', active: 1 }, f);
    const r = await env.DB.prepare(
      'INSERT INTO ad_campaigns (product_id, label, currency, daily_amount, start_date, end_date, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(cols.product_id, cols.label, cols.currency, cols.daily_amount, cols.start_date, cols.end_date, cols.active, ts, ts).run();
    await auditStmt(env, user.email, 'ads-add', null, null, `campaign#${r.meta.last_row_id}`).run();
    await ensureAccrued(env, undefined, { force: true });
    return json({ ok: true, id: r.meta.last_row_id }, 201);
  }
  if ((mt = p.match(/^\/api\/ads\/campaigns\/(\d+)$/))) {
    const id = parseInt(mt[1], 10);
    const cur = await env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?').bind(id).first();
    if (!cur) fail(404, 'Кампания не найдена');
    if (m === 'PATCH') {
      const b = await readJson(req);
      const f = await cleanCampaign(env, b, cur);
      const today = almatyToday();
      if ('active' in f && !('end_date' in f)) {
        if (!f.active && cur.active) {
          // Switched off: accrual stops after today (today's row stays).
          if (!cur.end_date || cur.end_date > today) f.end_date = today;
        } else if (f.active && !cur.active) {
          // Switched on again: bring the stopped period up to date first, fill the stopped days with 0 so they are not charged later, and run on.
          await ensureAccrued(env, undefined, { force: true });
          if (cur.end_date && cur.end_date < today) {
            const from = addDays(cur.end_date, 1), to = addDays(today, -1);
            const lastRow = await env.DB.prepare('SELECT MAX(date) AS d FROM ad_spend WHERE campaign_id = ?').bind(id).first();
            const zero = [];
            for (let d = lastRow && lastRow.d && lastRow.d >= from ? addDays(lastRow.d, 1) : from; d <= to && zero.length < AD_BACKFILL_DAYS; d = addDays(d, 1)) {
              zero.push({ campaignId: id, date: d, amountOrig: 0, currency: cur.currency, rate: 1, amountKzt: 0 });
            }
            const st = spendInsertStmts(env, zero, 'auto');
            if (st.length) await env.DB.batch(st);
          }
          if (cur.end_date && cur.end_date <= today) f.end_date = '';
        }
      }
      const keys = Object.keys(f);
      if (keys.length) {
        f.updated_at = nowIso();
        const names = Object.keys(f);
        await env.DB.batch([
          env.DB.prepare(`UPDATE ad_campaigns SET ${names.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...names.map((k) => f[k]), id),
          auditStmt(env, user.email, 'ads-edit', null, null, `campaign#${id} ${keys.join(',')}`)
        ]);
        await ensureAccrued(env, undefined, { force: true });
      }
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM ad_spend WHERE campaign_id = ?').bind(id),
        env.DB.prepare('DELETE FROM ad_campaigns WHERE id = ?').bind(id),
        auditStmt(env, user.email, 'ads-del', null, null, `campaign#${id}`)
      ]);
      return json({ ok: true });
    }
  }
  if (p === '/api/ads/spend' && m === 'GET') {
    await ensureAccrued(env);
    const { from, to } = dayRange(url, 14);
    const { results } = await env.DB.prepare('SELECT * FROM ad_spend WHERE date >= ? AND date <= ? ORDER BY date, campaign_id').bind(from, to).all();
    return json({ from, to, spend: (results || []).map(spendOut) });
  }
  if ((mt = p.match(/^\/api\/ads\/spend\/(\d+)\/(\d{4}-\d{2}-\d{2})$/)) && m === 'PUT') {
    const id = parseInt(mt[1], 10), date = mt[2];
    if (!isDate(date)) fail(400, 'Дата указана неверно');
    if (date > almatyToday()) fail(400, 'Расход можно указать только за сегодня и раньше');
    const c = await env.DB.prepare('SELECT * FROM ad_campaigns WHERE id = ?').bind(id).first();
    if (!c) fail(404, 'Кампания не найдена');
    const b = await readJson(req);
    const amount = numIn('amount_orig' in b ? b.amount_orig : b.amountOrig, 0, 1e9, 'Расход', false);
    let rate = 1;
    if (c.currency === 'USD') {
      const r = (await usdRates(env, [date])).get(date);
      if (!r) fail(502, 'Не удалось получить курс доллара. Укажите «Курс доллара вручную» в настройках.');
      rate = r.rate;
    }
    const kzt = money2(amount * rate);
    await env.DB.prepare(
      "INSERT INTO ad_spend (campaign_id, date, amount_orig, currency, rate, amount_kzt, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?) " +
      "ON CONFLICT(campaign_id, date) DO UPDATE SET amount_orig = excluded.amount_orig, currency = excluded.currency, rate = excluded.rate, amount_kzt = excluded.amount_kzt, source = 'manual', updated_at = excluded.updated_at"
    ).bind(id, date, amount, c.currency, rate, kzt, nowIso()).run();
    return json({ ok: true, spend: { campaignId: id, date, amountOrig: amount, currency: c.currency, rate, amountKzt: kzt, source: 'manual' } });
  }
  if (p === '/api/ads/leads' && m === 'GET') {
    // Contacts from targeted ads whose first message falls into the Almaty days [from, to], grouped by ad code and product name.
    const { from, to } = dayRange(url, 14);
    const { results } = await env.DB.prepare(
      "SELECT target_code AS code, product_name AS productName, COUNT(*) AS n FROM contacts WHERE traffic = 'target' AND first_message_at != '' " +
      "AND date(first_message_at, '+5 hours') >= ? AND date(first_message_at, '+5 hours') <= ? GROUP BY target_code, product_name"
    ).bind(from, to).all();
    return json({ from, to, leads: results || [] });
  }
  fail(404, 'Не найдено');
}

/* ---------- router ---------- */
async function api(req, env, url) {
  const m = req.method, p = url.pathname;
  let mt;

  // Meta webhook: verified by the verify token (GET) and the HMAC signature (POST), not by the CRM key.
  if (p === '/api/hooks/whatsapp') return whatsappHook(req, env, url);

  // WhatsApp connector (linked device on a VM): Bearer key, no cookie and no CSRF check.
  if (p.startsWith('/api/connector/')) return connectorApi(req, env, url);

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
      waConnected: !!env.WA_TOKEN || await connectorInstalled(env)
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
        if (k === 'usd_manual' && v.trim() && !(parseFloat(v.replace(',', '.')) > 0 && parseFloat(v.replace(',', '.')) < 100000)) fail(400, 'Курс доллара: число больше 0, например 500');
        if (k === 'track_msg' && v.length > 2000) fail(400, 'Шаблон сообщения слишком длинный');
        stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(k, k === 'templates' || k === 'track_msg' ? v : v.trim()));
      }
      if (stmts.length) await env.DB.batch(stmts);
      // A new manual dollar rate: accrue the USD days that were waiting for a rate right away.
      if (user.role === 'admin' && 'usd_manual' in b) await ensureAccrued(env, undefined, { force: true });
      return json({ ok: true });
    }
  }

  /* advertising costs and exchange rate: admin only (managers never see ad spend) */
  if (p === '/api/fx' || p.startsWith('/api/ads/')) { requireAdmin(user); return adsApi(req, env, url, user); }

  const inbox = await inboxApi(req, env, url, user);
  if (inbox) return inbox;

  /* everything below is admin only */
  if (p === '/api/finance' && m === 'GET') {
    requireAdmin(user);
    await ensureAccrued(env);
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
    if (mt[1] !== 'general') {
      if ('extras' in b) d.extras = cleanExtras(b.extras);
      else { // a save without extras keeps the saved ones
        const old = await env.DB.prepare('SELECT data FROM finance WHERE key = ?').bind(mt[1]).first();
        let prev = {}; try { prev = old ? JSON.parse(old.data) : {}; } catch (e) { prev = {}; }
        if (Array.isArray(prev.extras)) d.extras = prev.extras;
      }
    }
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
const MAX_FILE = 1536 * 1024;               // D1 rows are limited to ~2 MB: files in the media table stay below 1.5 MB
const MAX_FILE_JSON = 3 * 1024 * 1024;     // base64 of 1.5 MB plus the JSON envelope
const CONNECTOR_STALE_MS = 2 * 60 * 1000;  // no word from the connector for 2 min = offline
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

// A WhatsApp message the connector could not decrypt is stored with this text (connector/src/map.js NOTE_UNDECRYPTED), so the
// client's chat appears at once; when WhatsApp delivers the same message again decrypted, fillUndecrypted puts the real content in.
const UNDECRYPTED_NOTE = 'Сообщение не расшифровалось — откройте этот чат на телефоне';
async function fillUndecrypted(env, ctx, had, msg, ev) {
  await env.DB.prepare('UPDATE messages SET type = ?, body = ?, caption = ?, media_id = ?, media_url = ?, media_mime = ?, media_ref = ? WHERE id = ?')
    .bind(msg.type, msg.body || '', msg.caption || '', msg.mediaId || '', msg.mediaUrl || '', msg.mime || '', msg.mediaRef || '', had.id).run();
  const c = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(had.contact_id).first();
  if (!c) return;
  const sets = [], binds = [];
  const last = await env.DB.prepare('SELECT id FROM messages WHERE contact_id = ? ORDER BY ts DESC, id DESC LIMIT 1').bind(c.id).first();
  if (last && last.id === had.id) { sets.push('last_preview = ?'); binds.push(previewOf(msg, 'in')); }
  // the source was decided from the placeholder: decide it again from the real first message
  const first = await env.DB.prepare("SELECT id FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY ts, id LIMIT 1").bind(c.id).first();
  if (first && first.id === had.id && !c.source_manual && c.traffic === 'organic' && ev.kind === 'message') {
    const src = detectSource({ text: msg.body || msg.caption, referral: msg.referral, targets: ctx.targets });
    sets.push('traffic = ?', 'platform = ?', 'target_code = ?', "product_name = CASE WHEN ? != '' THEN ? ELSE product_name END");
    binds.push(src.traffic, src.platform || '', src.code || '', src.product || '', src.product || '');
  }
  if (!sets.length) return;
  sets.push('updated_at = ?'); binds.push(nowIso());
  await env.DB.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, c.id).run();
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
  if (msg.undecrypted) { msg.type = 'other'; msg.body = UNDECRYPTED_NOTE; msg.caption = ''; msg.mediaRef = ''; msg.referral = null; }
  if (msg.id) {
    const had = await env.DB.prepare('SELECT id, contact_id, body, type FROM messages WHERE ext_msg_id = ?').bind(msg.id).first();
    if (had) {   // webhook retry, or the real content of a message that first arrived undecryptable
      if (!msg.undecrypted && had.type === 'other' && had.body === UNDECRYPTED_NOTE) await fillUndecrypted(env, ctx, had, msg, ev);
      return;
    }
  }
  const number = await ensureWaNumber(env, ctx.numbers, ev.phoneNumberId, ev.displayPhone, ctx.connection);
  const live = ev.kind === 'message';
  const ts = msg.ts;

  // @lid chats: the phone is known (waId = phone, lid = anonymous id) -> merge an older lid contact into the phone contact;
  // the phone is unknown (waId = lid) -> use the phone if an earlier alias knows it, else the contact is "lid only" (no phone shown).
  let waId = ev.waId, lidOnly = !!ev.lid && ev.lid === ev.waId;
  if (ev.lid && !lidOnly) await learnAliases(env, [{ lid: ev.lid, phone: ev.waId }]);
  else if (lidOnly) {
    const al = await env.DB.prepare('SELECT phone FROM wa_alias WHERE lid = ?').bind(ev.lid).first();
    if (al) { waId = al.phone; lidOnly = false; }
  }

  let contact = await env.DB.prepare("SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?").bind(waId).first();
  if (!contact) {
    // The source is decided once, on the first message: live inbound -> detect; history sync -> old; the owner wrote first -> organic.
    let src = { traffic: 'organic', platform: '', code: '', product: '' };
    if (ev.kind === 'history') src.traffic = 'old';
    else if (live && !msg.undecrypted) src = detectSource({ text: msg.body || msg.caption, referral: msg.referral, targets: ctx.targets });
    // undecryptable first message: organic for now, decided again when its real text arrives (fillUndecrypted)
    await env.DB.prepare(
      "INSERT INTO contacts (channel, ext_id, phone, id_kind, name, traffic, platform, target_code, product_name, number_id, first_message_at, created_at, updated_at) " +
      "VALUES ('whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, ext_id) DO NOTHING"
    ).bind(waId, lidOnly ? '' : waId, lidOnly ? 'lid' : 'pn', ev.profileName || '', src.traffic, src.platform, src.code, src.product, number ? number.id : null, ts, nowIso(), nowIso()).run();
    contact = await env.DB.prepare("SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?").bind(waId).first();
  }
  if (!contact) return;
  if (lidOnly && contact.id_kind !== 'lid') {   // a row written before lids were known (phone = lid digits)
    await env.DB.prepare("UPDATE contacts SET id_kind = 'lid', phone = '' WHERE id = ?").bind(contact.id).run();
    contact.id_kind = 'lid'; contact.phone = '';
  }

  const out = ev.direction === 'out';
  const ins = await env.DB.prepare(
    'INSERT INTO messages (contact_id, direction, number_id, ext_msg_id, type, body, media_id, media_url, media_mime, caption, status, from_app, ts, created_at, media_ref) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ext_msg_id) DO NOTHING'
  ).bind(contact.id, ev.direction, number ? number.id : null, msg.id || null, msg.type, msg.body || '', msg.mediaId || '', msg.mediaUrl || '', msg.mime || '',
    msg.caption || '', out ? 'sent' : 'received', out ? 1 : 0, ts, nowIso(), msg.mediaRef || '').run();
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
    "wa_jid = CASE WHEN ?10 != '' THEN ?10 ELSE wa_jid END, " +
    'updated_at = ?8 WHERE id = ?9'
  ).bind(ev.profileName || '', ts, preview, ev.direction, live ? 1 : 0, live ? 1 : 0, number ? number.id : null, nowIso(), contact.id, ev.chatJid || '').run();
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

// ---- @lid <-> phone ----
// WhatsApp may address a chat by an anonymous id (lid) instead of the phone number. The connector learns lid -> phone pairs
// (history sync, contacts, live messages) and reports them as 'alias' events; the CRM keeps them in wa_alias and merges a contact
// that was created under the lid into the contact of the phone. Everything is idempotent.
// One contact out of two rows of the same person: the earliest first message, the newest last message, summed unread, the source
// of the earlier row (a source set by a person always wins), the order link and the number of whichever has them.
function mergeContactRows(p, l) {
  const first = [p.first_message_at, l.first_message_at].filter(Boolean).sort()[0] || '';
  const pl = p.last_message_at || '', ll = l.last_message_at || '';
  const lastRow = ll > pl ? l : p;
  let srcRow = p;
  if (!p.source_manual && l.source_manual) srcRow = l;
  else if (!!p.source_manual === !!l.source_manual && l.first_message_at && (!p.first_message_at || l.first_message_at < p.first_message_at)) srcRow = l;
  return {
    first_message_at: first,
    last_message_at: lastRow.last_message_at || '',
    last_preview: lastRow.last_preview || '',
    last_inbound_at: [p.last_inbound_at, l.last_inbound_at].filter(Boolean).sort().pop() || '',
    unread: (p.unread || 0) + (l.unread || 0),
    name: p.name || l.name || '',
    order_id: p.order_id != null ? p.order_id : (l.order_id != null ? l.order_id : null),
    number_id: p.number_id != null ? p.number_id : (l.number_id != null ? l.number_id : null),
    traffic: srcRow.traffic, platform: srcRow.platform || '', target_code: srcRow.target_code || '', product_name: srcRow.product_name || '',
    source_manual: (p.source_manual || l.source_manual) ? 1 : 0
  };
}

// pairs: [{lid, phone}]. Records them and moves a contact created under the lid to the phone (rename when the phone has no
// contact yet, merge otherwise). Costs ~2 queries plus 2-4 statements per moved pair (maxMoves keeps one request under the D1 free-plan limit).
async function learnAliases(env, pairs, maxMoves = 1000) {
  const map = new Map();
  for (const p of pairs) if (p && p.lid && p.phone && p.lid !== p.phone) map.set(p.lid, p.phone);
  if (!map.size) return;
  const ts = nowIso();
  const list = [...map];
  let moves = 0;
  for (let i = 0; i < list.length; i += 30) {
    const part = list.slice(i, i + 30);
    const ids = [...new Set(part.flat())];
    const { results } = await env.DB.prepare(
      `SELECT * FROM contacts WHERE channel = 'whatsapp' AND ext_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    const by = new Map((results || []).map((r) => [r.ext_id, r]));
    const groups = [[env.DB.prepare(
      `INSERT INTO wa_alias (lid, phone, created_at) VALUES ${part.map(() => '(?, ?, ?)').join(', ')} ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone WHERE phone != excluded.phone`
    ).bind(...part.flatMap(([lid, phone]) => [lid, phone, ts]))]];
    for (const [lid, phone] of part) {
      const lc = by.get(lid), pc = by.get(phone);
      if (!lc || moves >= maxMoves) continue;   // beyond the cap only the alias is stored; the move happens on a later alias event
      moves++;
      if (!pc) {
        groups.push([
          env.DB.prepare("UPDATE contacts SET ext_id = ?1, phone = ?1, id_kind = 'pn', updated_at = ?2 WHERE id = ?3").bind(phone, ts, lc.id),
          env.DB.prepare('UPDATE outbox SET to_ext = ?1 WHERE contact_id = ?2').bind(phone, lc.id)
        ]);
        by.delete(lid); by.set(phone, Object.assign({}, lc, { ext_id: phone, phone, id_kind: 'pn' }));
        continue;
      }
      const m = mergeContactRows(pc, lc);
      groups.push([
        env.DB.prepare('UPDATE messages SET contact_id = ?1 WHERE contact_id = ?2').bind(pc.id, lc.id),
        env.DB.prepare('UPDATE outbox SET contact_id = ?1, to_ext = ?2 WHERE contact_id = ?3').bind(pc.id, phone, lc.id),
        env.DB.prepare(
          "UPDATE contacts SET first_message_at = ?1, last_message_at = ?2, last_preview = ?3, last_inbound_at = ?4, unread = ?5, name = ?6, order_id = ?7, number_id = ?8, " +
          "traffic = ?9, platform = ?10, target_code = ?11, product_name = ?12, source_manual = ?13, id_kind = 'pn', phone = ?14, updated_at = ?15 WHERE id = ?16"
        ).bind(m.first_message_at, m.last_message_at, m.last_preview, m.last_inbound_at, m.unread, m.name, m.order_id, m.number_id,
          m.traffic, m.platform, m.target_code, m.product_name, m.source_manual, phone, ts, pc.id),
        env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(lc.id)
      ]);
      by.delete(lid); by.set(phone, Object.assign({}, pc, m));
    }
    // each group is one pair; groups are never split between two batches
    let cur = [];
    for (const g of groups) {
      if (cur.length + g.length > 80) { await env.DB.batch(cur); cur = []; }
      cur.push(...g);
    }
    if (cur.length) await env.DB.batch(cur);
  }
}

// Old chats (WhatsApp history sync), names and lid aliases. The Cloudflare free plan allows ~50 D1 queries per request, so a batch
// of history events is written with a handful of statements: one DB.batch with [create chat] + [insert message] + [update chat summary].
// Everything is idempotent: a repeated batch changes nothing (messages are unique by ext_msg_id, the summary is recomputed
// with MIN/MAX). History never raises «unread» and creates chats as «Старый клиент» (traffic = old).
//
// WhatsApp may deliver the same conversation twice, once under the phone and once under the lid, with the same message ids. ext_msg_id
// is unique, so the second copy used to find all its messages taken by the first contact, while its summary (last message preview)
// was still written: a chat in the list with a preview and an empty thread. Now a chat whose messages already belong to another
// contact is the same chat: lid + phone are merged (alias), anything else is routed to the owner of the messages. The summary
// is only written for a contact that really has messages.
// The chat id of the newest message of a chat of this batch that carried one.
const jidOf = (c) => c.msgs.reduce((a, e) => (e.chatJid && (!a || e.msg.ts >= a.ts) ? { ts: e.msg.ts, jid: e.chatJid } : a), null)?.jid || '';
async function ingestHistory(env, ctx, events) {
  const aliasPairs = events.filter((e) => e.kind === 'alias').map((e) => ({ lid: e.lid, phone: e.phone }));
  if (aliasPairs.length) await learnAliases(env, aliasPairs, 6);
  const seenPairs = [];
  for (const ev of events) if (ev.kind !== 'alias' && ev.lid && ev.lid !== ev.waId) seenPairs.push({ lid: ev.lid, phone: ev.waId });
  if (seenPairs.length) await learnAliases(env, seenPairs, 4);

  // lid-only events -> the phone when an alias is known
  const known = new Map();
  const lidOnly = new Set(events.filter((e) => e.kind !== 'alias' && e.kind !== 'contact' && e.waId && e.lid && e.lid === e.waId).map((e) => e.lid));
  const lookup = [...new Set([...lidOnly, ...events.filter((e) => (e.kind === 'contact' || e.kind === 'chat') && e.waId).map((e) => e.waId)])];
  for (let i = 0; i < lookup.length; i += 90) {
    const part = lookup.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT lid, phone FROM wa_alias WHERE lid IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results || []) known.set(r.lid, r.phone);
  }
  const idOf = (ev) => ((ev.kind === 'contact' || ev.kind === 'chat' || (ev.lid && ev.lid === ev.waId)) && known.has(ev.waId) ? known.get(ev.waId) : ev.waId);

  const chats = new Map();       // waId -> {name, number, msgs: [], lidOnly}
  const names = new Map();       // waId -> name from 'contact' events
  const chatEvs = new Map();     // waId -> 'chat' event: a chat of the phone without messages (created as a contact only)
  for (const ev of events) {
    if (ev.kind === 'alias' || !ev.waId) continue;
    const waId = idOf(ev);
    if (ev.kind === 'contact') { if (ev.profileName) names.set(waId, ev.profileName); continue; }
    if (ev.kind === 'chat') {
      const prev = chatEvs.get(waId);
      if (!prev || (ev.lastTs || '') > (prev.lastTs || '')) chatEvs.set(waId, Object.assign({}, ev, { lidOnly: lidOnly.has(waId), profileName: ev.profileName || (prev && prev.profileName) || '' }));
      continue;
    }
    if (!ev.msg) continue;
    let c = chats.get(waId);
    if (!c) { c = { name: '', number: await ensureWaNumber(env, ctx.numbers, ev.phoneNumberId, ev.displayPhone, ctx.connection), msgs: [], ids: new Set(), lidOnly: lidOnly.has(waId) }; chats.set(waId, c); }
    if (ev.profileName && !c.name) c.name = ev.profileName;
    if (ev.msg.id) { if (c.ids.has(ev.msg.id)) continue; c.ids.add(ev.msg.id); }
    c.msgs.push(Object.assign({}, ev, { waId }));
  }

  // Messages of this batch that already belong to another contact: the same chat under another id.
  const allIds = [...chats.values()].flatMap((c) => [...c.ids]);
  const owner = new Map();
  const placeholders = new Set();   // ids stored as «не расшифровалось»: this batch brings their real content
  for (let i = 0; i < allIds.length; i += 90) {
    const part = allIds.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT m.ext_msg_id AS mid, c.ext_id AS ext, c.id_kind AS kind, (m.type = 'other' AND m.body = ?) AS ph FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.ext_msg_id IN (${part.map(() => '?').join(',')})`
    ).bind(UNDECRYPTED_NOTE, ...part).all();
    for (const r of results || []) { owner.set(r.mid, { ext: r.ext, kind: r.kind }); if (r.ph) placeholders.add(r.mid); }
  }
  const moved = [];
  for (const [waId, c] of [...chats]) {
    const tally = new Map();
    for (const id of c.ids) {
      let o = owner.get(id);
      if (!o) { owner.set(id, { ext: waId, kind: c.lidOnly ? 'lid' : 'pn' }); continue; }   // first claim inside this very batch
      if (o.ext !== waId) tally.set(o.ext, { n: (tally.get(o.ext) || { n: 0 }).n + 1, kind: o.kind });
    }
    if (!tally.size) continue;
    const [ext, t] = [...tally].sort((x, y) => y[1].n - x[1].n)[0];
    if (c.lidOnly && t.kind !== 'lid') moved.push({ lid: waId, phone: ext });           // this chat is the lid copy of a phone chat
    else if (!c.lidOnly && t.kind === 'lid') moved.push({ lid: ext, phone: waId });     // the phone copy of a chat first stored under a lid
    else { c.target = ext; }                                                              // same kind of id: attach to the owner
  }
  if (moved.length) {
    await learnAliases(env, moved, 4);
    for (const [waId, c] of [...chats]) {
      const hit = moved.find((x) => x.lid === waId);
      if (hit) { c.target = hit.phone; c.lidOnly = false; }
    }
  }
  // fold chats that were redirected into the target chat
  for (const [waId, c] of [...chats]) {
    if (!c.target || c.target === waId) continue;
    chats.delete(waId);
    const t = chats.get(c.target);
    if (t) { for (const ev of c.msgs) if (!t.ids.has(ev.msg.id)) { if (ev.msg.id) t.ids.add(ev.msg.id); t.msgs.push(ev); } if (!t.name) t.name = c.name; }
    else { c.msgs = c.msgs.map((ev) => Object.assign({}, ev, { waId: c.target })); chats.set(c.target, c); }
  }

  const ts0 = nowIso();
  const stmts = [];
  const number0 = chatEvs.size ? await ensureWaNumber(env, ctx.numbers, events.find((e) => e.kind === 'chat').phoneNumberId, events.find((e) => e.kind === 'chat').displayPhone, ctx.connection) : null;
  // Chats without messages: one statement each. The row is created (traffic 'old'); an existing one only gets what it lacks
  // (chat id, name, last-message time while it has no messages), and is not written at all when nothing changes.
  for (const [waId, ev] of chatEvs) {
    if (chats.has(waId)) continue;
    const bindAll = [waId, ev.lidOnly ? '' : waId, ev.lidOnly ? 'lid' : 'pn', ev.profileName || names.get(waId) || '', number0 ? number0.id : null, ev.lastTs || '', ev.chatJid || '', ts0];
    // INSERT ... SELECT ... WHERE NOT EXISTS and a guarded UPDATE: an existing, unchanged chat writes no D1 row at all
    // (an INSERT ... ON CONFLICT on an AUTOINCREMENT table still writes one row to sqlite_sequence).
    stmts.push(env.DB.prepare(
      "INSERT INTO contacts (channel, ext_id, phone, id_kind, name, traffic, number_id, first_message_at, last_message_at, wa_jid, created_at, updated_at) " +
      "SELECT 'whatsapp', ?1, ?2, ?3, ?4, 'old', ?5, '', ?6, ?7, ?8, ?8 WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?1)"
    ).bind(...bindAll));
    stmts.push(env.DB.prepare(
      "UPDATE contacts SET wa_jid = CASE WHEN ?7 != '' THEN ?7 ELSE wa_jid END, name = CASE WHEN name = '' THEN ?4 ELSE name END, " +
      "last_message_at = CASE WHEN ?6 > last_message_at AND NOT EXISTS (SELECT 1 FROM messages WHERE contact_id = contacts.id) THEN ?6 ELSE last_message_at END, updated_at = ?8 " +
      "WHERE channel = 'whatsapp' AND ext_id = ?1 AND ((?7 != '' AND wa_jid != ?7) OR (name = '' AND ?4 != '') OR (?6 > last_message_at AND NOT EXISTS (SELECT 1 FROM messages WHERE contact_id = contacts.id)))"
    ).bind(waId, null, null, bindAll[3], null, bindAll[5], bindAll[6], ts0));
  }
  for (const [waId, c] of chats) {
    const nm = c.name || names.get(waId) || '';
    const first = c.msgs.reduce((a, e) => (e.msg.ts < a ? e.msg.ts : a), c.msgs[0].msg.ts);
    stmts.push(env.DB.prepare(
      "INSERT INTO contacts (channel, ext_id, phone, id_kind, name, traffic, number_id, first_message_at, created_at, updated_at) VALUES ('whatsapp', ?1, ?2, ?3, ?4, 'old', ?5, ?6, ?7, ?7) ON CONFLICT(channel, ext_id) DO NOTHING"
    ).bind(waId, c.lidOnly ? '' : waId, c.lidOnly ? 'lid' : 'pn', nm, c.number ? c.number.id : null, first, ts0));
    if (c.lidOnly) stmts.push(env.DB.prepare("UPDATE contacts SET id_kind = 'lid', phone = '' WHERE channel = 'whatsapp' AND ext_id = ?1 AND id_kind != 'lid'").bind(waId));
  }
  for (const [waId, c] of chats) {
    for (const ev of c.msgs) {
      const m = ev.msg, out = ev.direction === 'out';
      stmts.push(env.DB.prepare(
        'INSERT INTO messages (contact_id, direction, number_id, ext_msg_id, type, body, media_id, media_url, media_mime, caption, status, from_app, ts, created_at, media_ref) ' +
        "SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15 FROM contacts WHERE channel = 'whatsapp' AND ext_id = ?1 ON CONFLICT(ext_msg_id) DO NOTHING"
      ).bind(waId, ev.direction, c.number ? c.number.id : null, m.id || null, m.type, m.body || '', m.mediaId || '', m.mediaUrl || '', m.mime || '',
        m.caption || '', out ? 'sent' : 'received', out ? 1 : 0, m.ts, ts0, m.mediaRef || ''));
      if (m.id && placeholders.has(m.id)) stmts.push(env.DB.prepare(
        "UPDATE messages SET type = ?1, body = ?2, caption = ?3 WHERE ext_msg_id = ?4 AND type = 'other' AND body = ?5"
      ).bind(m.type, m.body || '', m.caption || '', m.id, UNDECRYPTED_NOTE));
    }
    // Summary of the chat from this batch (only moves forward / backward, so order and repeats do not matter).
    const latest = c.msgs.reduce((a, e) => (e.msg.ts >= a.msg.ts ? e : a), c.msgs[0]);
    const lastIn = c.msgs.filter((e) => e.direction === 'in').reduce((a, e) => (e.msg.ts > a ? e.msg.ts : a), '');
    const first = c.msgs.reduce((a, e) => (e.msg.ts < a ? e.msg.ts : a), c.msgs[0].msg.ts);
    stmts.push(env.DB.prepare(
      'UPDATE contacts SET ' +
      "name = CASE WHEN name = '' THEN ?1 ELSE name END, " +
      "first_message_at = CASE WHEN first_message_at = '' OR ?2 < first_message_at THEN ?2 ELSE first_message_at END, " +
      'last_preview = CASE WHEN ?3 >= last_message_at THEN ?4 ELSE last_preview END, ' +
      'last_message_at = CASE WHEN ?3 >= last_message_at THEN ?3 ELSE last_message_at END, ' +
      "last_inbound_at = CASE WHEN ?5 > last_inbound_at THEN ?5 ELSE last_inbound_at END, " +
      "number_id = COALESCE(number_id, ?6), wa_jid = CASE WHEN ?9 != '' THEN ?9 ELSE wa_jid END, updated_at = ?7 WHERE channel = 'whatsapp' AND ext_id = ?8 " +
      'AND EXISTS (SELECT 1 FROM messages WHERE contact_id = contacts.id)'
    ).bind(c.name || names.get(waId) || '', first, latest.msg.ts, previewOf(latest.msg, latest.direction), lastIn, c.number ? c.number.id : null, ts0, waId, jidOf(c)));
  }
  // Answers to «load older messages»: done = nothing older than the anchor arrived. Written after the messages of this batch.
  for (const r of events) {
    if (r.kind !== 'history_result') continue;
    stmts.push(env.DB.prepare(
      'UPDATE contacts SET history_answered_at = ?1, history_done = CASE WHEN EXISTS (SELECT 1 FROM messages WHERE contact_id = contacts.id AND ts < ?2) THEN 0 ELSE 1 END ' +
      "WHERE id = (SELECT contact_id FROM outbox WHERE id = ?3 AND type = 'history')"
    ).bind(ts0, r.anchorTs, r.outboxId));
  }
  for (const [waId, nm] of names) {
    if (!chats.has(waId)) stmts.push(env.DB.prepare("UPDATE contacts SET name = ?1, updated_at = ?2 WHERE channel = 'whatsapp' AND ext_id = ?3 AND name = ''").bind(nm, ts0, waId));
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  await classifyFreshHistory(env, ctx, [...chats.keys()], ts0);
}

// A chat that first reaches the CRM through history (the connector was offline, or a new QR pairing brought back chats it had
// missed) but whose FIRST message is recent is a new client, not an old one: its source is detected from that first message and
// it is shown unread when the client wrote last. Only rows created by this very batch (created_at = ts0) are touched.
const FRESH_HISTORY_MS = 72 * 3600 * 1000;
async function classifyFreshHistory(env, ctx, waIds, ts0) {
  const ids = [...new Set(waIds.filter(Boolean))];
  if (!ids.length) return;
  const since = new Date(Date.parse(ts0) - FRESH_HISTORY_MS).toISOString();
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      "SELECT c.id, " +
      "(SELECT m.body FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' ORDER BY m.ts, m.id LIMIT 1) AS first_in, " +
      "(SELECT m.direction FROM messages m WHERE m.contact_id = c.id ORDER BY m.ts DESC, m.id DESC LIMIT 1) AS last_dir " +
      `FROM contacts c WHERE c.channel = 'whatsapp' AND c.created_at = ? AND c.traffic = 'old' AND c.source_manual = 0 AND c.first_message_at >= ? AND c.ext_id IN (${part.map(() => '?').join(',')})`
    ).bind(ts0, since, ...part).all();
    for (const r of results || []) if (r.first_in != null) rows.push(r);
  }
  if (!rows.length) return;
  let targets = ctx.targets;
  if (!targets || !targets.length) { const t = await env.DB.prepare('SELECT * FROM target_texts WHERE active = 1').all(); targets = t.results || []; }
  const stmts = rows.map((r) => {
    const src = detectSource({ text: r.first_in === UNDECRYPTED_NOTE ? '' : r.first_in || '', referral: null, targets });
    return env.DB.prepare(
      "UPDATE contacts SET traffic = ?, platform = ?, target_code = ?, product_name = CASE WHEN ? != '' THEN ? ELSE product_name END, " +
      "unread = CASE WHEN ? = 'in' AND unread = 0 THEN 1 ELSE unread END, updated_at = ? WHERE id = ? AND traffic = 'old' AND source_manual = 0"
    ).bind(src.traffic, src.platform || '', src.code || '', src.product || '', src.product || '', r.last_dir || '', nowIso(), r.id);
  });
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

// The one ingest path for every connector (Cloud API webhook, QR connector via /api/hooks/inbox).
// A non-2xx answer makes the sender retry; inserts are idempotent (ext_msg_id), so a retry is safe.
async function ingestEvents(env, events, connection) {
  if (!events.length) return 0;
  const isBulk = (e) => e.kind === 'history' || e.kind === 'contact' || e.kind === 'alias' || e.kind === 'chat' || e.kind === 'history_result';
  const bulk = events.filter(isBulk);
  const live = bulk.length ? events.filter((e) => !isBulk(e)) : events;
  const { results: targets } = live.length ? await env.DB.prepare('SELECT * FROM target_texts WHERE active = 1').all() : { results: [] };
  const ctx = { targets: targets || [], numbers: new Map(), connection };
  let failed = 0;
  for (const ev of live) {
    try { await processWaEvent(env, ctx, ev); }
    catch (e) { failed++; console.error('whatsapp event failed:', e && e.message ? String(e.message).slice(0, 150) : 'unknown'); }
  }
  if (bulk.length) {
    try { await ingestHistory(env, ctx, bulk); }
    catch (e) { failed++; console.error('whatsapp history failed:', e && e.message ? String(e.message).slice(0, 150) : 'unknown'); }
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
    id: r.id, productName: r.product_name, productId: r.product_id || '', code: r.code, text: r.text, active: !!r.active, clicks: r.clicks, note: r.note,
    contacts: r.contacts == null ? 0 : r.contacts
  };
}
function chatOut(r) {
  return {
    id: r.id, channel: r.channel, name: r.name, phone: r.id_kind === 'lid' ? '' : r.phone, idKind: r.id_kind === 'lid' ? 'lid' : 'pn', traffic: r.traffic, platform: r.platform, targetCode: r.target_code,
    productName: r.product_name, numberId: r.number_id, numberLabel: r.number_label || r.number_phone || '', numberStatus: r.number_status || '',
    numberConnection: r.number_connection || '',
    lastAt: r.last_message_at, lastInboundAt: r.last_inbound_at, preview: r.last_preview, unread: r.unread,
    orderId: r.order_id == null ? null : r.order_id, orderNum: r.order_num == null ? null : r.order_num, manual: !!r.source_manual,
    historyDone: !!r.history_done
  };
}
function messageOut(r) {
  return {
    id: r.id, direction: r.direction, type: r.type, body: r.body, caption: r.caption, hasMedia: !!(r.media_id || r.media_url || r.media_ref), mime: r.media_mime,
    status: r.status, fromApp: !!r.from_app, ts: r.ts
  };
}

const CHAT_SELECT =
  'SELECT c.*, n.label AS number_label, n.phone AS number_phone, n.status AS number_status, n.connection AS number_connection, o.num AS order_num ' +
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

// The business number a chat belongs to, with the checks every outgoing message needs.
async function chatNumber(env, c) {
  if (c.channel !== 'whatsapp') fail(400, 'Ответ в этом канале пока не поддерживается');
  const num = c.number_id ? await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(c.number_id).first() : null;
  if (!num) fail(409, 'Не известно, на какой номер писал клиент. Ответьте из приложения WhatsApp на телефоне.');
  if (num.status === 'blocked') {
    fail(409, `Номер ${num.label || num.phone} заблокирован — с него ответить нельзя. Ответьте клиенту из приложения WhatsApp или с запасного номера.`, { code: 'blocked' });
  }
  if (num.status === 'off') fail(409, `Номер ${num.label || num.phone} выключен в настройках — с него ответить нельзя.`, { code: 'off' });
  return num;
}

// The linked-device connector row when it is the one that serves this number (token created, logged in with this very number).
async function boundConnector(env, num) {
  if (num.connection !== 'qr') return null;
  const row = await env.DB.prepare('SELECT * FROM connector WHERE id = 1').first();
  return row && row.token_hash && row.phone === num.phone ? row : null;
}

// QR connector route: store the message as 'queued' and put it into the outbox; the connector pulls it within seconds.
async function queueOutgoing(env, user, c, num, conn, { type, text, mediaRef, mime, seconds = 0, waveform = '' }) {
  const ts = nowIso();
  const preview = previewOf({ type, body: type === 'text' ? text : '', caption: type === 'image' ? text : '' }, 'out');
  const res = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (contact_id, direction, number_id, ext_msg_id, type, body, media_mime, caption, media_ref, status, from_app, ts, created_at) " +
      "VALUES (?, 'out', ?, NULL, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)"
    ).bind(c.id, num.id, type, type === 'text' ? text : '', mime || '', type === 'image' ? text : '', mediaRef || '', ts, ts),
    env.DB.prepare(
      'INSERT INTO outbox (contact_id, message_id, number_id, to_ext, type, text, media_ref, status, created_at, updated_at, seconds, waveform) ' +
      "VALUES (?, last_insert_rowid(), ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)"
    ).bind(c.id, num.id, c.ext_id, type, text || '', mediaRef || '', ts, ts, seconds, waveform),
    env.DB.prepare('UPDATE contacts SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?').bind(ts, preview, ts, c.id),
    auditStmt(env, user.email, 'chat-send', null, null, `chat#${c.id}${type === 'text' ? '' : ' ' + type}`)
  ]);
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(res[0].meta.last_row_id).first();
  const seen = Date.parse(conn.last_seen_at || '');
  const warning = !seen || Date.now() - seen > CONNECTOR_STALE_MS ? 'Сервер WhatsApp не на связи — сообщение уйдёт, когда он появится' : '';
  return json({ ok: true, message: row ? messageOut(row) : null, warning });
}

async function sendChatMessage(env, user, idStr, b) {
  const c = await loadChat(env, idStr);
  const text = str(b.text, 4096, 'Сообщение');
  if (!text) fail(400, 'Введите сообщение');
  const num = await chatNumber(env, c);
  const conn = await boundConnector(env, num);
  if (conn) return queueOutgoing(env, user, c, num, conn, { type: 'text', text });
  const route = sendRoute(env, num);
  if (!route) fail(503, 'Номер не подключён');
  if (route === 'cloud' && c.id_kind === 'lid') fail(409, 'У этого клиента номер скрыт WhatsApp: ответить можно только через подключённый по QR номер или с телефона');
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

// Decodes a base64 file from the browser, validates mime and size, returns {mime, bytes}.
function decodeFile(b, kind) {
  const raw = typeof b.data === 'string' ? b.data.replace(/^data:[^,]*,/, '') : '';
  if (!raw) fail(400, 'Файл не получен');
  if (raw.length > Math.ceil(MAX_FILE / 3) * 4 + 8) fail(413, 'Файл больше 1,5 МБ');
  const mime = String(b.mime || '').trim().toLowerCase().slice(0, 100);
  const ok = kind === 'voice' ? /^audio\/(ogg|webm|mp4|mpeg|aac|x-m4a|wav)(;[ a-z0-9=.,_-]*)?$/.test(mime) : /^image\/(jpeg|png|webp)$/.test(mime);
  if (!ok) fail(400, kind === 'voice' ? 'Формат записи не поддерживается' : 'Фото: только JPEG, PNG или WebP');
  let bytes;
  try { bytes = fromB64(raw); } catch (e) { fail(400, 'Файл повреждён'); }
  if (!bytes.length) fail(400, 'Файл пустой');
  if (bytes.length > MAX_FILE) fail(413, 'Файл больше 1,5 МБ');
  return { mime, bytes };
}

async function storeMedia(env, mime, bytes) {
  const id = toHex(crypto.getRandomValues(new Uint8Array(12)));
  await env.DB.prepare('INSERT INTO media (id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, mime, bytes.length, bytes, nowIso()).run();
  return id;
}

// POST /api/chats/:id/voice | /image: {data: base64, mime, caption?}; only through the QR connector.
async function sendChatFile(env, user, idStr, b, type) {
  const c = await loadChat(env, idStr);
  const num = await chatNumber(env, c);
  const conn = await boundConnector(env, num);
  if (!conn) fail(409, 'Голосовые и фото отправляются через «Сервер WhatsApp» (Настройки). Для этого номера он не подключён.');
  const caption = type === 'image' ? str(b.caption, 1024, 'Подпись') : '';
  const f = decodeFile(b, type);
  const mediaRef = await storeMedia(env, f.mime, f.bytes);
  const wave = type === 'voice' ? voiceWave(b) : { seconds: 0, waveform: '' };
  return queueOutgoing(env, user, c, num, conn, { type, text: caption, mediaRef, mime: f.mime.split(';')[0], seconds: wave.seconds, waveform: wave.waveform });
}

// Optional duration + waveform of a voice note (computed in the browser). Anything malformed is ignored: the voice is sent without them.
function voiceWave(b) {
  const seconds = Number(b && b.seconds);
  let wf = '';
  if (typeof (b && b.waveform) === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(b.waveform)) wf = b.waveform;   // 64 bytes in base64
  else if (Array.isArray(b && b.waveform) && b.waveform.length === 64 && b.waveform.every((x) => Number.isFinite(Number(x)))) {
    wf = btoa(String.fromCharCode(...b.waveform.map((x) => Math.max(0, Math.min(100, Math.round(Number(x)))))));
  }
  return { seconds: Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600 ? Math.round(seconds) : 0, waveform: wf };
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
// D1 returns BLOB columns as an array of byte values (or an ArrayBuffer, depending on the runtime).
function blobBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return Uint8Array.from(Array.isArray(v) ? v : []);
}

async function mediaProxy(req, env, idStr) {
  const id = parseInt(idStr, 10);
  const m = id > 0 ? await env.DB.prepare('SELECT media_id, media_url, media_mime, media_ref FROM messages WHERE id = ?').bind(id).first() : null;
  if (!m || (!m.media_id && !m.media_url && !m.media_ref)) fail(404, 'Файл не найден');
  let meta, buf;
  if (m.media_ref) {
    // File stored in D1 (connector files, voice notes and photos sent from the CRM).
    const f = await env.DB.prepare('SELECT mime, data FROM media WHERE id = ?').bind(m.media_ref).first();
    if (!f) fail(404, 'Файл удалён (вложения хранятся ограниченное время)');
    buf = blobBytes(f.data).buffer;
    meta = { mime_type: f.mime };
  } else if (m.media_url) {
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

// One-time repair (2026-11-06): until connector fc453ee+fix, messages that reached the phone while the laptop was off were
// delivered on reconnect as "append" and stored as history: new clients of those nights got traffic 'old', no source and no
// unread mark. The last pairing (history import) finished on 2026-11-04 ~16:05 UTC, so a chat marked 'old' whose FIRST message is
// later than that cannot come from history: re-detect its source on its first inbound message and mark it unread if the client
// wrote last. Runs once (settings flag), all updates in one batch.
const OFFLINE_REPAIR_FLAG = 'repair_offline_old_v1';
const OFFLINE_REPAIR_SINCE = '2026-11-04T17:00:00.000Z';
async function repairOfflineOld(env) {
  try {
    const done = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(OFFLINE_REPAIR_FLAG).first();
    if (done) return;
    const { results } = await env.DB.prepare(
      "SELECT c.id, " +
      "(SELECT m.body FROM messages m WHERE m.contact_id = c.id AND m.direction = 'in' ORDER BY m.ts LIMIT 1) AS first_in, " +
      "(SELECT m.direction FROM messages m WHERE m.contact_id = c.id ORDER BY m.ts DESC, m.id DESC LIMIT 1) AS last_dir " +
      "FROM contacts c WHERE c.channel = 'whatsapp' AND c.traffic = 'old' AND c.source_manual = 0 AND c.first_message_at >= ? LIMIT 2000"
    ).bind(OFFLINE_REPAIR_SINCE).all();
    const rows = (results || []).filter((r) => r.first_in != null);
    const { results: targets } = rows.length ? await env.DB.prepare('SELECT * FROM target_texts WHERE active = 1').all() : { results: [] };
    const stmts = rows.map((r) => {
      const src = detectSource({ text: r.first_in || '', referral: null, targets: targets || [] });
      return env.DB.prepare(
        "UPDATE contacts SET traffic = ?, platform = ?, target_code = ?, product_name = CASE WHEN ? != '' THEN ? ELSE product_name END, " +
        "unread = CASE WHEN ? = 'in' AND unread = 0 THEN 1 ELSE unread END, updated_at = ? WHERE id = ? AND traffic = 'old' AND source_manual = 0"
      ).bind(src.traffic, src.platform || '', src.code || '', src.product || '', src.product || '', r.last_dir || '', nowIso(), r.id);
    });
    stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(OFFLINE_REPAIR_FLAG, nowIso() + ' ' + rows.length));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  } catch (e) { console.error('offline repair failed'); }
}

async function listChats(env, url) {
  await repairOfflineOld(env);
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
  else if (filter === 'old') where.push("c.traffic = 'old'");
  const { results } = await env.DB.prepare(
    CHAT_SELECT + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY c.last_message_at DESC, c.id DESC LIMIT ' + (q ? 3000 : 500)
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
  // A short thread (fewer than 30 messages) asks the phone for older ones by itself, once in 10 min per chat.
  if ((results || []).length < HISTORY_MIN_MSGS) {
    try { await queueHistory(env, c, { auto: true }); } catch (e) { console.error('history request failed:', e && e.message ? String(e.message).slice(0, 150) : 'unknown'); }
  }
  const chat = chatOut(c);
  chat.historyPending = historyPending(c);
  return json({ chat, messages: (results || []).reverse().map(messageOut) });
}

/* ----- older messages on demand (the way WhatsApp Web loads them: the phone is asked for a page before the oldest known message) ----- */
const HISTORY_COUNT = 50;                       // messages asked per request
const HISTORY_MIN_MSGS = 30;                    // a thread shorter than this asks by itself
const HISTORY_AUTO_GAP_MS = 10 * 60 * 1000;     // ... not more often than once per chat in 10 min
const HISTORY_PENDING_MS = 5 * 60 * 1000;       // an unanswered request counts as pending this long
const HISTORY_RATE_MAX = 20, HISTORY_RATE_MS = 10 * 60 * 1000;   // at most 20 requests per 10 min overall
const HISTORY_DAY_MAX = 60;                     // ... and 60 per 24 h: every answer of 50 messages writes ~215 D1 rows (4.3 per message), the free plan allows 100k rows a day

const historyPending = (c) => !!c.history_requested_at && c.history_requested_at > (c.history_answered_at || '') && Date.now() - Date.parse(c.history_requested_at) < HISTORY_PENDING_MS;
function historyPayload(text) {
  try {
    const o = JSON.parse(text || '{}');
    return { chatJid: String(o.chatJid || ''), oldest: o.oldest && typeof o.oldest === 'object' ? o.oldest : null, count: Number(o.count) || HISTORY_COUNT, bestEffort: o.bestEffort === true };
  } catch (e) { return { chatJid: '', oldest: null, count: HISTORY_COUNT, bestEffort: false }; }
}
const chatJidOf = (c) => c.wa_jid || `${c.ext_id}@${c.id_kind === 'lid' ? 'lid' : 's.whatsapp.net'}`;

// Queues one 'history' outbox item for a chat. Returns {queued: true} or {queued: false, reason}:
// done | pending | recent (auto only) | no-connector | rate | day | busy. Never throws for a normal "no".
// The checks "one pending request per chat" and "rate limits" are part of the INSERT itself, so two parallel requests cannot both pass.
async function queueHistory(env, c, { auto }) {
  if (c.channel !== 'whatsapp') return { queued: false, reason: 'no-connector' };
  if (c.history_done) return { queued: false, reason: 'done' };
  if (historyPending(c)) return { queued: false, reason: 'pending' };
  if (auto && c.history_requested_at && Date.now() - Date.parse(c.history_requested_at) < HISTORY_AUTO_GAP_MS) return { queued: false, reason: 'recent' };
  const num = c.number_id ? await env.DB.prepare('SELECT * FROM wa_numbers WHERE id = ?').bind(c.number_id).first() : null;
  const conn = num ? await boundConnector(env, num) : null;
  const seen = conn ? Date.parse(conn.last_seen_at || '') : 0;
  if (!conn || conn.state !== 'open' || !seen || Date.now() - seen > CONNECTOR_STALE_MS) return { queued: false, reason: 'no-connector' };
  // Anchor: the oldest message we hold. A chat without messages (WhatsApp keeps only its entry in the list) is asked "before the
  // last message time" without a message id: best effort, the phone may answer with nothing.
  const a = await env.DB.prepare("SELECT ext_msg_id, direction, ts FROM messages WHERE contact_id = ? AND ext_msg_id IS NOT NULL AND ext_msg_id != '' ORDER BY ts ASC, id ASC LIMIT 1").bind(c.id).first();
  let oldest, bestEffort = false;
  if (a) oldest = { id: a.ext_msg_id, fromMe: a.direction === 'out', tsMs: Date.parse(a.ts) };
  else {
    const last = Date.parse(c.last_message_at || '');
    oldest = { id: '', fromMe: false, tsMs: (last > 0 ? last : Date.now()) + 1000 };
    bestEffort = true;
  }
  const ts = nowIso();
  const payload = JSON.stringify({ chatJid: chatJidOf(c), oldest, count: HISTORY_COUNT, bestEffort });
  const r = await env.DB.prepare(
    "INSERT INTO outbox (contact_id, message_id, number_id, to_ext, type, text, media_ref, status, created_at, updated_at, seconds, waveform) " +
    "SELECT ?1, NULL, ?2, ?3, 'history', ?4, '', 'queued', ?5, ?5, 0, '' " +
    "WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE contact_id = ?1 AND type = 'history' AND status IN ('queued', 'sending')) " +
    "AND (SELECT COUNT(*) FROM outbox WHERE type = 'history' AND created_at > ?6) < ?7 " +
    "AND (SELECT COUNT(*) FROM outbox WHERE type = 'history' AND created_at > ?8) < ?9"
  ).bind(c.id, num.id, c.ext_id, payload, ts, new Date(Date.now() - HISTORY_RATE_MS).toISOString(), HISTORY_RATE_MAX, new Date(Date.now() - 86400000).toISOString(), HISTORY_DAY_MAX).run();
  if (!r.meta.changes) {
    const n = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM outbox WHERE contact_id = ?1 AND type = 'history' AND status IN ('queued', 'sending')) AS mine, " +
      "(SELECT COUNT(*) FROM outbox WHERE type = 'history' AND created_at > ?2) AS recent"
    ).bind(c.id, new Date(Date.now() - HISTORY_RATE_MS).toISOString()).first();
    return { queued: false, reason: n.mine ? 'pending' : n.recent >= HISTORY_RATE_MAX ? 'rate' : 'day' };
  }
  await env.DB.prepare('UPDATE contacts SET history_requested_at = ? WHERE id = ?').bind(ts, c.id).run();
  c.history_requested_at = ts;
  return { queued: true };
}

// POST /api/chats/:id/older — the button «Загрузить более ранние сообщения»
async function olderMessages(env, idStr) {
  const c = await loadChat(env, idStr);
  const r = await queueHistory(env, c, { auto: false });
  if (!r.queued) {
    if (r.reason === 'pending') return json({ ok: true, pending: true });
    if (r.reason === 'done') fail(409, 'Более ранних сообщений нет');
    if (r.reason === 'no-connector') fail(409, 'Сервер WhatsApp не на связи или не подключён: попросить телефон показать старые сообщения сейчас нельзя');
    fail(429, r.reason === 'rate' ? 'Слишком много запросов старых сообщений. Подождите несколько минут.' : 'На сегодня лимит запросов старых сообщений исчерпан. Попробуйте завтра.');
  }
  return json({ ok: true, pending: true });
}

// Numbers for the diagnostics block in Settings (one request, a few cheap COUNTs).
async function diagnostics(env) {
  const r = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM contacts WHERE channel = 'whatsapp') AS contacts, " +
    "(SELECT COUNT(*) FROM contacts WHERE channel = 'whatsapp' AND id_kind != 'lid') AS withPhone, " +
    "(SELECT COUNT(*) FROM contacts WHERE channel = 'whatsapp' AND id_kind = 'lid') AS lidOnly, " +
    "(SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM wa_alias) AS aliases, " +
    "(SELECT COUNT(*) FROM outbox WHERE type = 'history' AND status IN ('queued', 'sending')) AS historyPending, " +
    "(SELECT COUNT(*) FROM contacts WHERE history_done = 1) AS historyDone, " +
    "(SELECT COUNT(*) FROM outbox WHERE type = 'history' AND status = 'failed') AS historyFailed"
  ).first();
  return r || {};
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

// Product of a target text: productId (checked against products; the display name is taken from it unless productName is given) or free productName.
async function targetProduct(env, b) {
  const name = 'productName' in b ? str(b.productName, 200, 'Товар') : '';
  const pid = 'productId' in b ? str(b.productId, 64, 'Товар') : '';
  if (!pid) return { id: '', name };
  const p = await env.DB.prepare('SELECT id, name FROM products WHERE id = ?').bind(pid).first();
  if (!p) fail(400, 'Товар не найден');
  return { id: p.id, name: name || p.name };
}

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
      const prod = await targetProduct(env, b);
      const r = await uniqueOr409(env.DB.prepare(
        'INSERT INTO target_texts (product_name, product_id, code, text, active, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(prod.name, prod.id, code, text, b.active === false ? 0 : 1, str(b.note, 300, 'Заметка'), ts, ts).run(), 'Такой код уже есть');
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
      if ('productId' in b || 'productName' in b) {
        const prod = await targetProduct(env, b);
        if (prod.name || 'productName' in b) set.product_name = prod.name;
        if ('productId' in b) set.product_id = prod.id;
      }
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
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/older$/)) && m === 'POST') return olderMessages(env, mt[1]);
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/send$/)) && m === 'POST') return sendChatMessage(env, user, mt[1], await readJson(req));
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/source$/)) && m === 'POST') return setChatSource(env, user, mt[1], await readJson(req));
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/order$/)) && m === 'POST') return orderFromChat(env, user, mt[1]);
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/voice$/)) && m === 'POST') return sendChatFile(env, user, mt[1], await readJson(req, MAX_FILE_JSON), 'voice');
  if ((mt = p.match(/^\/api\/chats\/(\d+)\/image$/)) && m === 'POST') return sendChatFile(env, user, mt[1], await readJson(req, MAX_FILE_JSON), 'image');
  if ((mt = p.match(/^\/api\/media\/(\d+)$/)) && m === 'GET') return mediaProxy(req, env, mt[1]);
  if (p === '/api/wa-server' || p.startsWith('/api/wa-server/')) return waServerApi(req, env, url, user);
  if (p === '/api/wa-numbers' || p.startsWith('/api/wa-numbers/')) return numbersApi(req, env, user, p, m);
  if (p === '/api/targets' || p.startsWith('/api/targets/')) return targetsApi(req, env, user, p, m);
  return null;
}

/* ---------- WhatsApp linked-device connector (QR) ----------
   A small Node program on a free VM (connector/ in the repo) holds the WhatsApp Web session and only makes outbound HTTPS
   calls here (pull model). Auth: Bearer key; only its SHA-256 is stored. Events go through the same ingestEvents() as every
   other source; outgoing messages wait in the `outbox` table until the connector claims them. */
const CONNECTOR_STATES = ['connecting', 'qr', 'open', 'closed', 'logged_out', 'banned', 'replaced', 'relinking'];
const OUTBOX_BATCH = 5;
const OUTBOX_STALE_MS = 2 * 60 * 1000;      // a claimed item without an ack goes back to the queue after 2 min
const OUTBOX_MAX_ATTEMPTS = 3;
const OUTBOX_EXPIRE_MS = 6 * 3600 * 1000;   // a reply nobody picked up for 6 h is not sent any more
const MEDIA_KEEP_DAYS = 120;
const QR_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

async function connectorInstalled(env) {
  try {
    const r = await env.DB.prepare('SELECT token_hash FROM connector WHERE id = 1').first();
    return !!(r && r.token_hash);
  } catch (e) { return false; }   // migration 0004 not applied yet
}

async function connectorAuth(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  const row = await env.DB.prepare('SELECT token_hash FROM connector WHERE id = 1').first();
  // Hash the candidate even when no key exists, so the response time does not tell whether a key was ever created.
  const hash = await sha256Hex(m ? m[1] : '');
  if (!m || !row || !row.token_hash || !(await safeEqual(hash, row.token_hash))) fail(401, 'Нет доступа');
}

async function connectorApi(req, env, url) {
  const p = url.pathname, m = req.method;
  await connectorAuth(req, env);
  let mt;
  if (p === '/api/connector/state' && m === 'POST') return connectorState(env, await readJson(req));
  if (p === '/api/connector/events' && m === 'POST') return connectorEvents(env, await readJson(req, MAX_HOOK_BODY));
  if (p === '/api/connector/media' && m === 'POST') return connectorMediaPut(env, await readJson(req, MAX_FILE_JSON));
  if ((mt = p.match(/^\/api\/connector\/media\/([A-Za-z0-9_-]{1,64})$/)) && m === 'GET') return connectorMediaGet(env, mt[1]);
  if (p === '/api/connector/outbox' && m === 'GET') return connectorOutbox(env, url);
  if (p === '/api/connector/ack' && m === 'POST') return connectorAck(env, await readJson(req));
  fail(404, 'Не найдено');
}

// Number logged in on the connector: make sure it exists, is the only 'qr' number and (first time / after «Переподключить») becomes current.
async function connectorOpened(env, row, phone) {
  const ts = nowIso();
  let num = await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone = ?').bind(phone).first();
  if (!num) {
    await env.DB.prepare(
      "INSERT INTO wa_numbers (phone, label, status, connection, is_current, note, created_at, updated_at) VALUES (?, '', 'active', 'qr', 0, 'Подключён по QR', ?, ?) ON CONFLICT DO NOTHING"
    ).bind(phone, ts, ts).run();
    num = await env.DB.prepare('SELECT * FROM wa_numbers WHERE phone = ?').bind(phone).first();
  }
  if (!num) return;
  const cur = await env.DB.prepare('SELECT id FROM wa_numbers WHERE is_current = 1').first();
  // A heartbeat of the very number that was linked before «Переподключить» must not undo the switch.
  const switching = row.switch_on_open === 1 && phone !== row.phone;
  const makeCurrent = (!cur && num.status === 'active') || switching;
  const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM wa_numbers WHERE connection = 'qr' AND id != ?").bind(num.id).first();
  if (num.connection === 'qr' && !others.n && !makeCurrent && !(row.phone && row.phone !== phone)) return;
  const stmts = [
    env.DB.prepare("UPDATE wa_numbers SET connection = 'qr', status = CASE WHEN ?2 = 1 THEN 'active' ELSE status END, updated_at = ?3 WHERE id = ?1").bind(num.id, switching ? 1 : 0, ts),
    env.DB.prepare("UPDATE wa_numbers SET connection = '', updated_at = ? WHERE connection = 'qr' AND id != ?").bind(ts, num.id)
  ];
  if (row.phone && row.phone !== phone) {
    // Messages queued for the previous number must never leave through the new one.
    stmts.push(env.DB.prepare("UPDATE messages SET status = 'failed' WHERE status = 'queued' AND id IN (SELECT message_id FROM outbox WHERE status IN ('queued', 'sending') AND number_id != ?)").bind(num.id));
    stmts.push(env.DB.prepare("UPDATE outbox SET status = 'failed', error = 'Номер отключён', updated_at = ? WHERE status IN ('queued', 'sending') AND number_id != ?").bind(ts, num.id));
  }
  if (makeCurrent) {
    stmts.push(env.DB.prepare('UPDATE wa_numbers SET is_current = 0, updated_at = ? WHERE is_current = 1 AND id != ?').bind(ts, num.id));
    stmts.push(env.DB.prepare('UPDATE wa_numbers SET is_current = 1, updated_at = ? WHERE id = ?').bind(ts, num.id));
    stmts.push(env.DB.prepare('UPDATE connector SET switch_on_open = 0 WHERE id = 1'));
    stmts.push(auditStmt(env, 'connector', 'wa-current', null, null, `number#${num.id} qr`));
  }
  await env.DB.batch(stmts);
}

async function connectorState(env, b) {
  const st = String(b.state || '');
  if (!CONNECTOR_STATES.includes(st)) fail(400, 'Неизвестное состояние');
  const row = await env.DB.prepare('SELECT * FROM connector WHERE id = 1').first();
  const ts = nowIso();
  const version = String(b.version || '').slice(0, 40);
  // The last CRM rejection the connector saw (status + start of the answer); '' clears it. Only a changed text costs a write.
  if (typeof b.lastError === 'string') {
    const le = b.lastError.slice(0, 300);
    if (le !== row.last_error) await env.DB.prepare('UPDATE connector SET last_error = ?, last_error_at = ? WHERE id = 1').bind(le, le ? ts : '').run();
  }
  // Random id of the connector process (new connectors only; '' keeps the previous one).
  const inst = /^[A-Za-z0-9]{4,40}$/.test(String(b.instance || '')) ? String(b.instance) : '';
  const SET_INST = "instance = CASE WHEN ?9 != '' THEN ?9 ELSE instance END";
  if (st === 'relinking') {
    // The connector acknowledges the relink command: only now it stops being pending.
    const cid = /^[A-Za-z0-9]{1,40}$/.test(String(b.commandId || '')) ? String(b.commandId) : '';
    await env.DB.prepare(
      `UPDATE connector SET state = 'relinking', qr_data = '', qr_at = '', version = ?1, last_seen_at = ?2, ${SET_INST}, ` +
      "pending_command = CASE WHEN pending_command = 'relink' AND (command_id = '' OR command_id = ?3) THEN '' ELSE pending_command END WHERE id = 1"
    ).bind(version, ts, cid, null, null, null, null, null, inst).run();
    return json({ ok: true });
  }
  if (row.pending_command === 'relink' && st === 'open') {
    // Heartbeat of the session that is about to be replaced: only proves the server is alive.
    await env.DB.prepare(`UPDATE connector SET last_seen_at = ?1, version = ?2, ${SET_INST} WHERE id = 1`).bind(ts, version, null, null, null, null, null, null, inst).run();
    return json({ ok: true });
  }
  if (st === 'qr') {
    const qr = typeof b.qr === 'string' && b.qr.length <= 60000 && QR_RE.test(b.qr) ? b.qr : '';
    await env.DB.prepare(
      `UPDATE connector SET state = 'qr', version = ?1, last_seen_at = ?2, qr_data = CASE WHEN ?3 != '' THEN ?3 ELSE qr_data END, qr_at = CASE WHEN ?3 != '' THEN ?2 ELSE qr_at END, ${SET_INST} WHERE id = 1`
    ).bind(version, ts, qr, null, null, null, null, null, inst).run();
  } else if (st === 'open') {
    const phone = digitsOf(b.phone);
    if (phone.length < 8 || phone.length > 15) fail(400, 'Не указан номер');
    await env.DB.prepare(`UPDATE connector SET state = 'open', qr_data = '', qr_at = '', phone = ?1, name = ?2, version = ?3, last_seen_at = ?4, ${SET_INST} WHERE id = 1`)
      .bind(phone, String(b.name || '').slice(0, 100), version, ts, null, null, null, null, inst).run();
    await connectorOpened(env, row, phone);
  } else {
    await env.DB.prepare(`UPDATE connector SET state = ?1, qr_data = '', qr_at = '', version = ?2, last_seen_at = ?3, ${SET_INST} WHERE id = 1`).bind(st, version, ts, null, null, null, null, null, inst).run();
  }
  return json({ ok: true });
}

async function connectorEvents(env, b) {
  const row = await env.DB.prepare('SELECT phone FROM connector WHERE id = 1').first();
  const list = Array.isArray(b.events) ? b.events : [];
  // Events carry their own business number; the connector's current number fills in when it is missing.
  for (const e of list) if (e && typeof e === 'object' && !digitsOf(e.numberPhone)) e.numberPhone = row.phone;
  const n = await ingestEvents(env, normalizeInboxEvents({ events: list }), 'qr');
  return json({ ok: true, accepted: n });
}

async function connectorMediaPut(env, b) {
  const mime = String(b.mime || '').trim().toLowerCase().slice(0, 100);
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+(;[ a-z0-9=.,_+-]*)?$/.test(mime)) fail(400, 'Неизвестный тип файла');
  const raw = typeof b.data === 'string' ? b.data : '';
  if (!raw) fail(400, 'Файл не получен');
  if (raw.length > Math.ceil(MAX_FILE / 3) * 4 + 8) fail(413, 'Файл больше 1,5 МБ');
  let bytes;
  try { bytes = fromB64(raw); } catch (e) { fail(400, 'Файл повреждён'); }
  if (!bytes.length || bytes.length > MAX_FILE) fail(413, 'Файл больше 1,5 МБ');
  return json({ ok: true, id: await storeMedia(env, mime, bytes) }, 201);
}

async function connectorMediaGet(env, id) {
  const f = await env.DB.prepare('SELECT mime, data FROM media WHERE id = ?').bind(id).first();
  if (!f) fail(404, 'Файл не найден');
  return new Response(blobBytes(f.data), { headers: { 'Content-Type': f.mime || 'application/octet-stream' } });
}

async function connectorOutbox(env, url) {
  const ts = nowIso();
  const inst = /^[A-Za-z0-9]{4,40}$/.test(url.searchParams.get('instance') || '') ? url.searchParams.get('instance') : '';
  const cur = await env.DB.prepare("SELECT pending_command, command_id, instance, last_seen_at FROM connector WHERE id = 1").first();
  if (cur && cur.pending_command === 'relink') {
    const seen = Date.parse(cur.last_seen_at || '');
    const aliveOther = !!cur.instance && !!seen && Date.now() - seen <= CONNECTOR_STALE_MS;
    if (!inst) {
      // Connector without an instance id (installed before this feature): the command is handed out once, as before, unless a newer
      // connector is alive (then this one is a stale copy and must not swallow the command).
      if (!aliveOther) {
        const cmd = await env.DB.prepare("UPDATE connector SET pending_command = '' WHERE id = 1 AND pending_command = 'relink'").run();
        if (cmd.meta.changes) return json({ items: [], command: 'relink' });
      }
    } else if (!aliveOther || cur.instance === inst) {
      // The command stays pending until this instance acknowledges it (state 'relinking' + commandId).
      return json({ items: [], command: 'relink', commandId: cur.command_id || '' });
    }
  }
  // Housekeeping: stuck 'sending' items return to the queue (max 3 attempts), very old queued items expire.
  const stale = new Date(Date.now() - OUTBOX_STALE_MS).toISOString();
  const expire = new Date(Date.now() - OUTBOX_EXPIRE_MS).toISOString();
  await env.DB.prepare("UPDATE outbox SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ? AND attempts < ?").bind(ts, stale, OUTBOX_MAX_ATTEMPTS).run();
  const dead = await env.DB.batch([
    env.DB.prepare("UPDATE outbox SET status = 'failed', error = 'Сервер WhatsApp не подтвердил отправку', updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2 AND attempts >= ?3 RETURNING message_id").bind(ts, stale, OUTBOX_MAX_ATTEMPTS),
    env.DB.prepare("UPDATE outbox SET status = 'failed', error = 'Сервер WhatsApp не вышел на связь', updated_at = ?1 WHERE status = 'queued' AND created_at < ?2 RETURNING message_id").bind(ts, expire)
  ]);
  const ids = [];
  for (const r of dead) for (const x of (r.results || [])) if (x.message_id) ids.push(x.message_id);
  if (ids.length) await env.DB.prepare(`UPDATE messages SET status = 'failed' WHERE status = 'queued' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  if (url.searchParams.get('ready') !== '1') return json({ items: [], command: null });
  const conn = await env.DB.prepare('SELECT phone FROM connector WHERE id = 1').first();
  const num = conn && conn.phone ? await env.DB.prepare('SELECT id FROM wa_numbers WHERE phone = ?').bind(conn.phone).first() : null;
  if (!num) return json({ items: [], command: null });
  // Atomic claim: the UPDATE itself picks the rows, so two pollers can never get the same message.
  const { results } = await env.DB.prepare(
    "UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?1 WHERE id IN " +
    `(SELECT id FROM outbox WHERE status = 'queued' AND number_id = ?2 ORDER BY id LIMIT ${OUTBOX_BATCH}) RETURNING id, contact_id, to_ext, type, text, media_ref, seconds, waveform`
  ).bind(ts, num.id).all();
  // A contact whose phone WhatsApp hides is addressed by its anonymous id: the connector sends to <id>@lid.
  const cids = [...new Set((results || []).map((r) => r.contact_id).filter(Boolean))];
  const lidIds = new Set();
  if (cids.length) {
    const lr = await env.DB.prepare(`SELECT id FROM contacts WHERE id_kind = 'lid' AND id IN (${cids.map(() => '?').join(',')})`).bind(...cids).all();
    for (const r of lr.results || []) lidIds.add(r.id);
  }
  const items = (results || []).sort((a, b) => a.id - b.id)
    .map((r) => r.type === 'history'
      ? Object.assign({ id: r.id, to: r.to_ext, type: 'history' }, historyPayload(r.text))
      : Object.assign({ id: r.id, to: r.to_ext, type: r.type, text: r.text, mediaRef: r.media_ref, seconds: r.seconds || 0, waveform: r.waveform || '' }, lidIds.has(r.contact_id) ? { lid: true } : {}));
  return json({ items, command: null });
}

async function connectorAck(env, b) {
  const id = parseInt(b.id, 10);
  const o = id > 0 ? await env.DB.prepare('SELECT * FROM outbox WHERE id = ?').bind(id).first() : null;
  if (!o) fail(404, 'Не найдено');
  if (o.status === 'sent') return json({ ok: true });
  const ts = nowIso();
  if (b.ok === true) {
    const ext = String(b.extMsgId || '').slice(0, 200);
    const stmts = [env.DB.prepare("UPDATE outbox SET status = 'sent', ext_msg_id = ?, error = '', updated_at = ? WHERE id = ?").bind(ext, ts, id)];
    if (o.message_id) {
      // If the phone-echo of this message was ingested before the ack, that row already owns the id: keep it, drop ours.
      const twin = ext ? await env.DB.prepare('SELECT id FROM messages WHERE ext_msg_id = ? AND id != ?').bind(ext, o.message_id).first() : null;
      if (twin) stmts.push(env.DB.prepare('UPDATE messages SET media_ref = CASE WHEN media_ref = \'\' THEN ?2 ELSE media_ref END WHERE id = ?1').bind(twin.id, o.media_ref || ''));
      if (twin) stmts.push(env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(o.message_id));
      else stmts.push(env.DB.prepare("UPDATE messages SET ext_msg_id = ?, status = CASE WHEN status IN ('delivered', 'read') THEN status ELSE 'sent' END WHERE id = ?").bind(ext || null, o.message_id));
    }
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  const error = String(b.error || 'Ошибка отправки').slice(0, 200);
  if (/not connected/i.test(error) && o.attempts < OUTBOX_MAX_ATTEMPTS) {
    await env.DB.prepare("UPDATE outbox SET status = 'queued', error = ?, updated_at = ? WHERE id = ?").bind(error, ts, id).run();
    return json({ ok: true, retry: true });
  }
  const stmts = [env.DB.prepare("UPDATE outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error, ts, id)];
  if (o.message_id) stmts.push(env.DB.prepare("UPDATE messages SET status = 'failed' WHERE id = ?").bind(o.message_id));
  // A failed history request is not pending any more (history_requested_at stays: the next automatic try is 10 min later).
  if (o.type === 'history') stmts.push(env.DB.prepare('UPDATE contacts SET history_answered_at = ? WHERE id = ?').bind(ts, o.contact_id));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/* ----- «Сервер WhatsApp» in Settings (admin) ----- */
function serverOut(r) {
  const seen = Date.parse(r.last_seen_at || '');
  const online = !!seen && Date.now() - seen <= CONNECTOR_STALE_MS;
  return {
    installed: !!r.token_hash, keyCreatedAt: r.token_created_at || '', state: r.state || '', online,
    minutesAgo: seen ? Math.max(0, Math.round((Date.now() - seen) / 60000)) : null, lastSeenAt: r.last_seen_at || '',
    phone: r.phone || '', name: r.name || '', version: r.version || '',
    qr: r.state === 'qr' && online && r.qr_data ? r.qr_data : '',
    relinkPending: r.pending_command === 'relink' || r.state === 'relinking',
    lastError: r.last_error || '', lastErrorAt: r.last_error_at || ''
  };
}

// The Windows installer: CRLF line endings, the CRM address and the key substituted (single occurrences, no $-patterns).
function windowsSetupFile(origin, token) {
  return WINDOWS_SETUP_TEMPLATE.replace(/\r?\n/g, '\r\n').replace('__CRM_URL__', () => origin).replace('__CONNECTOR_TOKEN__', () => token);
}
// New connection key: the previous one stops working at once and the connector state is reset.
async function rotateConnectorKey(env, user, detail) {
  const token = randomToken();
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE connector SET token_hash = ?, token_created_at = ?, state = '', qr_data = '', qr_at = '', last_seen_at = '', version = '', pending_command = '', command_id = '', instance = '', switch_on_open = 0 WHERE id = 1")
      .bind(await sha256Hex(token), ts),
    auditStmt(env, user.email, 'wa-server-key', null, null, detail)
  ]);
  return token;
}

async function waServerApi(req, env, url, user) {
  requireAdmin(user);
  const p = url.pathname, m = req.method;
  if (p === '/api/wa-server' && m === 'GET') {
    const [row, diag] = await Promise.all([env.DB.prepare('SELECT * FROM connector WHERE id = 1').first(), diagnostics(env)]);
    return json({ server: serverOut(row), diag });
  }
  if (p === '/api/wa-server/key' && m === 'POST') {
    const token = await rotateConnectorKey(env, user, '');
    const script = CLOUD_INIT_TEMPLATE.replace('__CRM_URL__', () => url.origin).replace('__CONNECTOR_TOKEN__', () => token);
    return json({ ok: true, script });
  }
  // Windows laptop: a new key (the old one stops working) embedded in a one-click installer file.
  if (p === '/api/wa-server/windows-installer' && m === 'POST') {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url.origin)) fail(500, 'Адрес CRM не подходит для установщика');
    const token = await rotateConnectorKey(env, user, 'windows');
    const body = windowsSetupFile(url.origin, token);
    return new Response(body, { status: 200, headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="BikasWhatsApp-setup.cmd"',
      'Cache-Control': 'no-store'
    } });
  }
  if (p === '/api/wa-server/relink' && m === 'POST') {
    const row = await env.DB.prepare('SELECT * FROM connector WHERE id = 1').first();
    if (!row.token_hash) fail(409, 'Сервер WhatsApp ещё не подключён: сначала создайте ключ и установите сервер.');
    await env.DB.batch([
      env.DB.prepare("UPDATE connector SET pending_command = 'relink', command_id = lower(hex(randomblob(6))), switch_on_open = 1, state = 'relinking', qr_data = '', qr_at = '' WHERE id = 1"),
      auditStmt(env, user.email, 'wa-server-relink', null, null, '')
    ]);
    return json({ ok: true });
  }
  // Same phone, new QR: WhatsApp sends the old chats only right after linking, so the link is redone. The current number is NOT switched.
  if (p === '/api/wa-server/reload-history' && m === 'POST') {
    const row = await env.DB.prepare('SELECT * FROM connector WHERE id = 1').first();
    if (!row.token_hash) fail(409, 'Сервер WhatsApp ещё не подключён: сначала создайте ключ и установите сервер.');
    await env.DB.batch([
      env.DB.prepare("UPDATE connector SET pending_command = 'relink', command_id = lower(hex(randomblob(6))), switch_on_open = 0, state = 'relinking', qr_data = '', qr_at = '' WHERE id = 1"),
      auditStmt(env, user.email, 'wa-server-reload-history', null, null, '')
    ]);
    return json({ ok: true });
  }
  fail(404, 'Не найдено');
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

// Files kept in D1 (connector media, voice notes): drop the old ones so the free database does not fill up.
async function cleanupMedia(env) {
  try { await env.DB.prepare('DELETE FROM media WHERE created_at < ?').bind(new Date(Date.now() - MEDIA_KEEP_DAYS * 86400000).toISOString()).run(); }
  catch (e) { console.error('media cleanup failed'); }
}

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
    ctx.waitUntil(ensureAccrued(env));
    if (event.cron === MORNING_CRON) ctx.waitUntil(cleanupMedia(env));
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

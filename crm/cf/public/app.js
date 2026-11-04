/* Bikas CRM: browser UI. Talks to the Worker REST API (/api/*). No inline scripts or styles (CSP). */
(function () {
'use strict';

/* ---------- constants ---------- */
var ST = [['new', 'Новый'], ['accepted', 'Принят'], ['pay', 'Ждёт оплату'], ['reserve', 'Резерв'], ['paid', 'Оплачен'], ['sent', 'Отправлен'], ['done', 'Получен'], ['cancel', 'Отказ']];
var STN = {}; ST.forEach(function (s) { STN[s[0]] = s[1]; });
var NEEDS = { reserve: 1, sent: 1 }; // statuses that need extra fields before they can be saved
var DELIVERY = ['Казпочта', 'Курьер', 'СДЭК'];
var PUBLISH_URL = 'https://github.com/sildar010386-cloud/ai-commerce-os/actions/workflows/publish.yml';
function ostat(o) { var k = o && o.status; if (k === 'work') return 'accepted'; return STN[k] ? k : 'new'; }
var PAID = { paid: 1, sent: 1, done: 1 };
var SOURCES = ['Threads', 'Instagram', 'TikTok', 'WhatsApp', 'Другое'];
var PERIODS = [['today', 'Сегодня', 1], ['week', 'Неделя', 7], ['month', 'Месяц', 30]];
var ADMIN_TABS = { summary: 1, profit: 1, managers: 1, bot: 1, settings: 1 };
var CHAT_POLL_MS = 10000;
var WA_HINT_BLOCK = 'Если номер заблокировали — отметьте «заблокирован» и выберите другой номер для ссылок. Реклама и лендинг продолжат работать.';
var COUNT_EXAMPLES = false; // orders with example:true are left out of all statistics
var LOW_STOCK = 5;
var TZ = 'Asia/Almaty';
var MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
var WDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
var CONTENT_STATUS = { 'ждёт': 's-pay', 'вышел': 's-paid', 'в боте': 's-accepted', 'ошибка': 's-cancel', 'не одобрено': 's-done' };
var POLL_MS = 30000;
// Defaults of the track message; the owner edits both in Настройки (the server sends the saved values).
var DEFAULT_TRACK_URL = 'https://post.kz/services/postal/{трек}';
var DEFAULT_TRACK_MSG = 'Здравствуйте, {имя}! Ваш заказ отправлен Казпочтой. Трек-номер: {трек}. Где сейчас посылка — по ссылке: {ссылка} Спасибо за покупку!';

/* ---------- state ---------- */
var S = {
  auth: false, booted: false, user: null, canDispatch: false, publishUrl: PUBLISH_URL,
  tab: 'orders', filter: 'all', q: '', period: 'week', contentDay: null,
  drawer: false, card: null, resetFor: null,
  admin: false, loaded: {}, errors: {},
  data: { orders: [], products: [], finance: {}, content: [], users: [], settings: null, bot: null, numbers: [], targets: [], server: null },
  winDownloaded: false, // the Windows installer was downloaded in this session
  serverScript: '', // initialization script shown once after «Создать ключ подключения» (kept in memory only)
  chat: null, waConnected: false,
  dirty: false, loginError: '',
  kz: null // Kazpost registry import panel (Заказы tab)
};

/* ---------- helpers ---------- */
function $(s, r) { return (r || document).querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function num(v) {
  var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\s| /g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
function fmt(n) {
  n = Math.round(n);
  var s = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
  return n < 0 ? '−' + s : s;
}
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
// Clean wa.me number: digits only, Kazakhstan 8XXXXXXXXXX -> 7XXXXXXXXXX. Empty when it cannot be a phone.
function waDigits(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}
// Tracking link for a Kazpost parcel: the template from Настройки with {трек} replaced (URL-encoded). '' when it cannot be built.
function trackUrl(track) {
  var tpl = (S.data.settings && S.data.settings.track_url) || DEFAULT_TRACK_URL;
  if (!track || !/^https:\/\//i.test(tpl)) return '';
  return tpl.split('{трек}').join(encodeURIComponent(track));
}
function trackMessage(o) {
  var tpl = (S.data.settings && S.data.settings.track_msg) || DEFAULT_TRACK_MSG;
  return tpl.split('{имя}').join(String(o.name || '').trim()).split('{трек}').join(o.track || '').split('{ссылка}').join(trackUrl(o.track))
    .replace(/,\s*!/g, '!');
}
function hasKzTrack(o) { return !!(o && o.track && o.delivery === 'Казпочта'); }
function trackLinkHTML(o) {
  var u = hasKzTrack(o) ? trackUrl(o.track) : '';
  return u ? ' <a class="trk-link" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Отследить</a>' : '';
}
var toastTimer = null;
function toast(msg, kind) {
  var el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + (kind === 'err' ? 'err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'err' ? 9000 : 3000);
}
function nowISO() { return new Date().toISOString(); }

/* ---------- API ---------- */
function ApiError(status, data) {
  this.status = status; this.data = data || {};
  this.message = (data && data.error) || ('Ошибка ' + status);
}
async function api(method, path, body) {
  var opts = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  var res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new ApiError(0, { error: 'нет связи с сервером' }); }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401 && path !== '/api/login') { goLogin(); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data || {};
}
// Runs a write, shows a short result message.
async function run(okMsg, fn) {
  try {
    await fn();
    if (okMsg) toast(okMsg, 'ok');
    return true;
  } catch (e) {
    toast('Не сохранилось: ' + e.message, 'err');
    return false;
  }
}

/* ---------- Asia/Almaty dates ---------- */
var dtf = null;
try { dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { dtf = null; }
function almaty(iso) {
  var d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return null;
  var p;
  if (dtf) {
    var o = {};
    dtf.formatToParts(d).forEach(function (x) { o[x.type] = x.value; });
    p = { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute };
  } else {
    var t = new Date(d.getTime() + 5 * 3600e3);
    p = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
  }
  p.dn = Math.round(Date.UTC(p.y, p.m - 1, p.d) / 864e5);
  p.key = p.y + '-' + (p.m < 10 ? '0' : '') + p.m + '-' + (p.d < 10 ? '0' : '') + p.d;
  return p;
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function todayP() { return almaty(nowISO()); }
function inPeriod(iso, period) {
  var p = almaty(iso), t = todayP();
  if (!p || !t) return false;
  var days = 1;
  PERIODS.forEach(function (x) { if (x[0] === period) days = x[2]; });
  var diff = t.dn - p.dn;
  return diff >= 0 && diff < days;
}
function periodDays(period) { var d = 1; PERIODS.forEach(function (x) { if (x[0] === period) d = x[2]; }); return d; }
function fmtDate(iso) {
  var p = almaty(iso), t = todayP();
  if (!p) return '';
  var diff = t.dn - p.dn, hm = pad2(p.h) + ':' + pad2(p.mi);
  if (diff === 0) return 'сегодня ' + hm;
  if (diff === 1) return 'вчера ' + hm;
  return p.d + ' ' + MONTHS[p.m - 1] + ' ' + hm;
}
function fmtDay(key) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] : '';
}
function dayLabel(key) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!m) return key || '';
  var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return WDAYS[dt.getUTCDay()] + ' ' + (+m[3]);
}

/* ---------- derived data ---------- */
function realOrders() { return S.data.orders.filter(function (o) { return COUNT_EXAMPLES || !o.example; }); }
function periodOrders(period) { return realOrders().filter(function (o) { return inPeriod(o.createdAt, period); }); }
function byNumDesc(a, b) {
  var d = num(b.num) - num(a.num);
  if (d) return d;
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}
function activeProducts() {
  return S.data.products.filter(function (p) { return p.active !== false; }).sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
}
function findProduct(id) { return S.data.products.filter(function (p) { return p.id === id; })[0]; }

/* ---------- header / drawer ---------- */
var TABS = [['orders', 'Заказы'], ['chats', 'Чаты'], ['summary', 'Сводка', 1], ['content', 'Контент'], ['goods', 'Товары']];
var DRAWER = [
  ['summary', 'Статистика и касса', 'Обращения, заказы, оплаты, касса', 1],
  ['profit', 'Прибыль и расходы', 'Закупка, доставка, расходы → чистая прибыль', 1],
  ['orders', 'Заказы', 'Все заказы по статусам', 0],
  ['chats', 'Чаты', 'Переписка WhatsApp, таргет или органика', 0],
  ['goods', 'Склад', 'Остатки и цены товаров', 0],
  ['managers', 'Менеджеры и доступы', 'Кто работает, пароли, доступ', 1],
  ['bot', 'Бот (ИИ-менеджер)', 'Сколько обработал, где позвал человека', 1],
  ['settings', 'Настройки', 'Номера WhatsApp, таргет-тексты, ссылка на оплату, шаблоны', 1],
  ['account', 'Моя почта и пароль', 'Смена почты, пароля, номера WhatsApp', 0]
];
var X_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
var COPY_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
function renderHeader() {
  var mb = $('#menu-btn'); if (mb) mb.classList.toggle('hide', !S.auth);
  $('#tabs').innerHTML = !S.auth ? '' : TABS.filter(function (t) { return S.admin || !t[2]; }).map(function (t) {
    return '<button type="button" class="tab' + (S.tab === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '"' + (S.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] +
      (t[0] === 'chats' && S.chat && S.chat.unreadTotal > 0 ? ' <span class="tbadge">' + esc(S.chat.unreadTotal > 99 ? '99+' : S.chat.unreadTotal) + '</span>' : '') + '</button>';
  }).join('');
  $('#role').textContent = S.auth && S.user ? (S.admin ? 'Админ' : 'Менеджер') + ' · ' + S.user.email : '';
}
function renderDrawer() {
  var root = $('#drawer-root');
  if (!S.drawer || !S.auth) { root.innerHTML = ''; return; }
  root.innerHTML = '<div class="scrim"><nav class="drawer" aria-label="Меню"><div class="dh"><span>Меню</span>' +
    '<button type="button" class="icon-btn" data-act="drawer-close" aria-label="Закрыть меню">' + X_SVG + '</button></div>' +
    DRAWER.filter(function (d) { return S.admin || !d[3]; }).map(function (d) {
      return '<button type="button" class="ditem' + (S.tab === d[0] ? ' on' : '') + '" data-act="tab" data-tab="' + d[0] + '"><b>' + d[1] + '</b><small>' + d[2] + '</small></button>';
    }).join('') + '<button type="button" class="ditem" data-act="logout"><b>Выйти</b><small>Завершить сеанс на этом устройстве</small></button>' +
    '</nav><button type="button" class="drawer-bg" data-act="drawer-close" aria-label="Закрыть меню"></button></div>';
}

/* ---------- view renderers ---------- */
function loadingHTML() { return '<div class="empty">Загружаем…</div>'; }
function periodChips() {
  return '<div class="row-flex">' + PERIODS.map(function (p) {
    return '<button type="button" class="chip' + (S.period === p[0] ? ' on' : '') + '" data-act="period" data-p="' + p[0] + '">' + p[1] + '</button>';
  }).join('') + '</div>';
}
function errNotice(key) {
  return S.errors[key] ? '<div class="notice">Не загрузилось: ' + esc(S.errors[key]) + '</div>' : '';
}

function renderLogin() {
  return '<form class="card login-card col12" id="login-form" autocomplete="on">' +
    '<div class="h1">Вход в CRM</div>' +
    (S.loginError ? '<div class="notice" role="alert">' + esc(S.loginError) + '</div>' : '') +
    '<div class="fld"><label for="l-login">Почта</label><input id="l-login" name="username" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>' +
    '<div class="fld"><label for="l-pass">Пароль</label><input id="l-pass" name="password" type="password" autocomplete="current-password" required></div>' +
    '<button type="submit" class="btn pri" id="l-submit">Войти</button></form>';
}

function stSelectHTML(st, selAttrs, big) {
  return '<div class="stsel s-' + st + (big ? ' big" id="card-stw' : '') + '"><select ' + selAttrs + '>' + ST.map(function (x) {
    return '<option value="' + x[0] + '"' + (x[0] === st ? ' selected' : '') + '>' + x[1] + '</option>';
  }).join('') + '</select></div>';
}
function remindDue() {
  var t = todayP(), key = t ? t.key : '';
  return S.data.orders.filter(function (o) { return ostat(o) === 'reserve' && o.remindAt && o.remindAt <= key; });
}
function renderOrders() {
  if (!S.loaded.orders) return loadingHTML();
  var q = S.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  var all = S.data.orders.filter(function (o) {
    if (!q) return true;
    var hay = (String(o.name || '') + ' ' + String(o.city || '') + ' ' + String(o.phone || '')).toLowerCase();
    if (hay.indexOf(q) >= 0) return true;
    return qd.length >= 3 && String(o.phone || '').replace(/\D/g, '').indexOf(qd) >= 0;
  });
  var counts = { all: all.length };
  ST.forEach(function (s) { counts[s[0]] = all.filter(function (o) { return ostat(o) === s[0]; }).length; });
  var tp = todayP(), today = tp ? tp.key : '';
  var due = remindDue(), dueIds = {};
  due.forEach(function (o) { dueIds[o.id] = 1; });
  var list = all.filter(function (o) {
    if (S.filter === 'remind') return !!dueIds[o.id];
    return S.filter === 'all' || ostat(o) === S.filter;
  }).sort(byNumDesc);
  var chips = '<button type="button" class="chip' + (S.filter === 'all' ? ' on' : '') + '" data-act="filter" data-f="all">Все <b>' + counts.all + '</b></button>' + ST.map(function (s) {
    return '<button type="button" class="chip cs s-' + s[0] + (S.filter === s[0] ? ' on' : '') + '" data-act="filter" data-f="' + s[0] + '">' + s[1] + ' <b>' + counts[s[0]] + '</b></button>';
  }).join('');
  var plaque = (due.length || S.filter === 'remind')
    ? '<button type="button" class="remind s-pay' + (S.filter === 'remind' ? ' on' : '') + '" data-act="filter" data-f="remind"><span>Сегодня напомнить: ' + due.length + '</span><small>' + (S.filter === 'remind' ? 'показать все' : 'показать') + '</small></button>' : '';
  var rows = list.map(function (o) {
    var st = ostat(o), sub = '';
    if (st === 'sent' && (o.delivery || o.track)) {
      sub = '<small class="dl">' + esc([o.delivery, o.track].filter(Boolean).join(' · ')) + trackLinkHTML(o) +
        (o.trackSentAt ? ' <span class="trk-ok">трек отправлен ✓</span>' : '') + '</small>';
    }
    else if (st === 'reserve' && o.remindAt) sub = '<small class="dl' + (o.remindAt <= today ? ' due' : '') + '">напомнить ' + esc(fmtDay(o.remindAt)) + '</small>';
    return '<div class="orow s-' + st + (o.example ? ' ex' : '') + '" role="button" tabindex="0" data-act="open-order" data-id="' + esc(o.id) + '">' +
      '<div class="c-num dim">№ ' + esc(o.num != null ? o.num : '—') + '</div>' +
      '<div class="c-dt dim">' + esc(fmtDate(o.createdAt)) + '</div>' +
      '<div class="cl"><b>' + esc(o.name || 'Без имени') + (o.example ? '<span class="badge b-ex">пример</span>' : '') + '</b><small>' + esc(o.city || '') + '</small></div>' +
      '<div class="c-pr">' + esc(o.productName || '—') + ' ×' + esc(o.qty || 1) + '</div>' +
      '<div class="sum">' + fmt(num(o.sum)) + '</div>' +
      '<div class="c-src">' + esc(o.source || '') + trafficBadge(o.traffic, o.targetCode) + '</div>' +
      '<div class="c-st">' + stSelectHTML(st, 'data-ost="' + esc(o.id) + '" aria-label="Статус заказа № ' + esc(o.num != null ? o.num : '') + '"', false) + sub + '</div></div>';
  }).join('');
  return errNotice('orders') + plaque + kzPanelHTML() +
    '<div class="row-flex">' + chips + '<span class="grow"></span><button type="button" class="btn" data-act="kz-open">Загрузить реестр Казпочты</button>' +
    '<input type="file" id="kz-file" class="hide" accept="application/pdf,.pdf" aria-label="PDF-реестр Казпочты">' +
    '<button type="button" class="btn pri" data-act="new-order">+ Новый заказ</button></div>' +
    '<div><label class="sr" for="orders-search">Поиск</label><input id="orders-search" type="search" placeholder="Поиск: имя, телефон, город" value="' + esc(S.q) + '" autocomplete="off"></div>' +
    '<div class="otbl"><div class="otbl-in"><div class="ohead"><div>№</div><div>Дата</div><div>Клиент</div><div>Товар</div><div>Сумма</div><div>Откуда</div><div>Статус</div></div>' +
    (rows || '<div class="empty">' + (S.filter === 'remind' ? 'На сегодня напоминаний нет.' : (S.data.orders.length ? 'Ничего не найдено.' : 'Заказов пока нет. Нажмите «+ Новый заказ».')) + '</div>') +
    '</div></div>';
}

function renderSummary() {
  if (!S.loaded.orders) return loadingHTML();
  var list = periodOrders(S.period);
  var nonCancel = list.filter(function (o) { return o.status !== 'cancel'; });
  var paid = list.filter(function (o) { return PAID[o.status]; });
  var cash = paid.reduce(function (s, o) { return s + num(o.sum); }, 0);
  var kpis = [['Обращения', list.length], ['Заказы', nonCancel.length], ['Оплатили', paid.length], ['Касса (выручка)', fmt(cash)]];
  var src = {};
  SOURCES.forEach(function (s) { src[s] = 0; });
  nonCancel.forEach(function (o) { var k = SOURCES.indexOf(o.source) >= 0 ? o.source : 'Другое'; src[k]++; });
  var max = Math.max.apply(null, SOURCES.map(function (s) { return src[s]; }).concat([1]));
  var colors = ['c1', 'c2', 'c3', 'c4', 'c5'];
  var srcHtml = SOURCES.map(function (s, i) {
    return '<div class="mb12"><div class="bar-line"><span>' + esc(s) + '</span><b>' + src[s] + '</b></div><div class="bar"><i class="bg-' + colors[i] + '" data-w="' + Math.round(src[s] / max * 100) + '"></i></div></div>';
  }).join('');
  var posts = {};
  paid.forEach(function (o) {
    var p = String(o.post || '').trim();
    if (!p) return;
    if (!posts[p]) posts[p] = { n: 0, sum: 0 };
    posts[p].n++; posts[p].sum += num(o.sum);
  });
  var top = Object.keys(posts).sort(function (a, b) { return posts[b].n - posts[a].n || posts[b].sum - posts[a].sum; }).slice(0, 5);
  var topHtml = top.length ? top.map(function (p) {
    return '<div class="post-row"><span>' + esc(p) + '</span><span class="nw"><b>' + posts[p].n + '</b> <small>опл.</small></span></div>';
  }).join('') : '<div class="muted fs14">Пока нет оплаченных заказов с указанным постом.</div>';
  var exCount = S.data.orders.filter(function (o) { return o.example; }).length;
  return errNotice('orders') + '<div class="h1">Статистика и касса</div>' + periodChips() +
    '<div class="kpis">' + kpis.map(function (k, i) { return '<div class="card kpi kc' + (i + 1) + '"><div class="k">' + k[0] + '</div><div class="v">' + k[1] + '</div></div>'; }).join('') + '</div>' +
    '<div class="two"><div class="card"><div class="fw6 mb12">Откуда пришли заказы</div>' + srcHtml + '</div>' +
    '<div class="card"><div class="fw6 mb6">С каких постов заказы</div>' + topHtml + '<small class="db mt8">Топ-5 постов по числу оплаченных заказов.</small></div></div>' +
    '<small>Период считается по дате создания заказа, часовой пояс Алматы.' + (exCount && !COUNT_EXAMPLES ? ' Примеры (' + exCount + ') в расчёт не входят.' : '') + '</small>';
}

function calcProfit(period) {
  var list = periodOrders(period).filter(function (o) { return PAID[o.status]; });
  var qty = 0, rev = 0, cost = 0, missing = {};
  list.forEach(function (o) {
    var q = num(o.qty) || 0, s = num(o.sum);
    qty += q; rev += s;
    var f = S.data.finance[o.productId];
    if (!f) { missing[o.productName || 'товар не выбран'] = 1; return; }
    cost += q * (num(f.buy) + num(f.ship) + num(f.pack) + num(f.other)) + s * num(f.feePct) / 100;
  });
  var fixed = num((S.data.finance.general || {}).fixedMonth) * periodDays(period) / 30;
  return { qty: qty, rev: rev, cost: cost, fixed: fixed, net: rev - cost - fixed, missing: Object.keys(missing) };
}
function unitProfit(price, f) {
  f = f || {};
  return price - num(f.buy) - num(f.ship) - num(f.pack) - price * num(f.feePct) / 100 - num(f.other);
}
function renderProfit() {
  if (!S.loaded.orders || !S.loaded.products || !S.loaded.finance) return loadingHTML();
  var fields = [['buy', 'Закупка', '₸'], ['ship', 'Доставка Казпочтой (платим мы)', '₸'], ['pack', 'Упаковка', '₸'], ['feePct', 'Комиссия за оплату', '%'], ['other', 'Прочее на 1 шт.', '₸']];
  var prods = activeProducts();
  var blocks = prods.map(function (p) {
    var f = S.data.finance[p.id] || {};
    var price = num(p.price), up = unitProfit(price, f);
    return '<div class="card"><div class="fw6 mb10">' + esc(p.name) + ': из чего складывается 1 штука</div>' +
      '<div class="eco-row"><span>Цена продажи</span><span class="in"><b>' + fmt(price) + '</b><span class="u"></span></span></div>' +
      fields.map(function (x) {
        return '<div class="eco-row"><label for="fin-' + esc(p.id) + '-' + x[0] + '">' + x[1] + '</label><span class="in"><input class="num" id="fin-' + esc(p.id) + '-' + x[0] + '" type="number" inputmode="decimal" min="0" step="any" data-fin="' + esc(p.id) + '" value="' + esc(num(f[x[0]])) + '"><span class="u">' + x[2] + '</span></span></div>';
      }).join('') +
      '<div class="sum-line big"><span>Прибыль с 1 шт.</span><span class="' + (up < 0 ? 'neg' : 'pos') + '">' + fmt(up) + '</span></div></div>';
  }).join('');
  if (!prods.length) blocks = '<div class="card empty">Активных товаров нет. Добавьте товар в разделе «Склад».</div>';
  var fixedCard = '<div class="card"><div class="eco-row mgn0"><label for="fin-fixed">Общие расходы в месяц</label><span class="in"><input class="num" id="fin-fixed" type="number" inputmode="decimal" min="0" step="any" value="' + esc(num((S.data.finance.general || {}).fixedMonth)) + '"><span class="u">₸</span></span></div></div>';
  var c = calcProfit(S.period);
  var res = '<div class="card top-g">' + periodChips() +
    '<div class="mt12">' +
    '<div class="sum-line"><span>Продано (оплачено)</span><span>' + c.qty + ' шт.</span></div>' +
    '<div class="sum-line"><span>Касса (выручка)</span><span class="pos"><b>' + fmt(c.rev) + '</b></span></div>' +
    '<div class="sum-line"><span>Расходы на товар</span><span class="neg">− ' + fmt(c.cost).replace('−', '') + '</span></div>' +
    '<div class="sum-line"><span>Общие расходы за период</span><span class="neg">− ' + fmt(c.fixed).replace('−', '') + '</span></div>' +
    '<div class="sum-line big"><span>Чистая прибыль</span><span class="' + (c.net < 0 ? 'neg' : 'pos') + '">' + fmt(c.net) + '</span></div></div>' +
    (c.missing.length ? '<div class="notice mt12">Не заполнены расходы на 1 шт. для: ' + esc(c.missing.join(', ')) + ' — прибыль завышена.</div>' : '') +
    '<small class="db mt10">Считается само: касса оплаченных заказов − расходы на товар − общие расходы (в месяц × дни периода / 30).</small></div>';
  return errNotice('finance') + '<div class="h1">Прибыль и расходы <small>видит только админ</small></div>' +
    '<div class="two"><div class="col12">' + blocks + fixedCard + '</div><div>' + res + '</div></div>';
}

function pendingContent(c) { return c.status === 'ждёт' || c.status === 'ошибка'; }
function publishCtl(label, date, time, cls) {
  if (!S.admin) return '';
  if (S.canDispatch) {
    return '<button type="button" class="btn ' + cls + '" data-act="publish" data-date="' + esc(date) + '" data-time="' + esc(time) + '">' + label + '</button>';
  }
  return '<a class="btn ' + cls + '" href="' + esc(S.publishUrl) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
}
function renderContent() {
  if (!S.loaded.content) return loadingHTML();
  var items = S.data.content;
  if (!items.length) return errNotice('content') + '<div class="h1">Контент</div><div class="card empty">План появится после одобрения пакета.</div>';
  var days = {};
  items.forEach(function (c) { if (c.date) days[c.date] = 1; });
  var all = Object.keys(days).sort(), t = todayP(), tk = t ? t.key : '';
  // owner 2026-11-02: past days are clutter - show today first and the days ahead only
  var keys = all.filter(function (k) { return !tk || k >= tk; });
  if (!keys.length) keys = all.slice(-1);
  if (!S.contentDay || keys.indexOf(S.contentDay) < 0) S.contentDay = keys[0];
  var chips = keys.map(function (k) {
    return '<button type="button" class="chip' + (S.contentDay === k ? ' on' : '') + '" data-act="content-day" data-d="' + esc(k) + '">' + esc(dayLabel(k)) + '</button>';
  }).join('');
  var slots = items.filter(function (c) { return c.date === S.contentDay; }).sort(function (a, b) { return String(a.time || '').localeCompare(String(b.time || '')); });
  var rows = slots.map(function (c) {
    var url = safeUrl(c.url), st = c.status || 'ждёт';
    return '<div class="slot ' + (CONTENT_STATUS[st] || 's-done') + '"><div class="tm">' + esc(c.time || '—') + '</div><div class="pl">' + esc(c.platform || '') + (c.type ? ' · ' + esc(c.type) : '') + '<br><code>' + esc(c.code || '') + '</code></div>' +
      '<div class="ti">' + esc(c.title || '') + '</div><span class="badge bs">' + esc(st) + '</span>' +
      (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">открыть</a>' : (c.url ? '<small>' + esc(c.url) + '</small>' : '')) +
      (pendingContent(c) ? '<span class="acts">' + publishCtl('Опубликовать сейчас', c.date, c.time, 'sm') + '</span>' : '') + '</div>';
  }).join('');
  var top = S.admin ? '<div class="row-flex"><span class="grow"></span>' + publishCtl('Опубликовать всё, чему пришло время', '', '', 'pri') + '</div>' : '';
  return errNotice('content') + '<div class="h1">Контент</div>' + top + '<div class="row-flex">' + chips + '</div>' +
    '<div class="scroll">' + rows + '</div>' +
    '<small>Посты выходят сами по расписанию.' + (S.admin ? (S.canDispatch ? ' Если какой-то не вышел — нажмите «Опубликовать сейчас»: запуск уйдёт в GitHub, пост выйдет через 1–2 минуты.' : ' Если какой-то не вышел — нажмите «Опубликовать сейчас», на открывшейся странице GitHub нажмите «Run workflow» и впишите дату и время слота.') : '') + '</small>';
}

function sold7(productId) {
  return realOrders().filter(function (o) { return o.productId === productId && PAID[o.status] && inPeriod(o.createdAt, 'week'); })
    .reduce(function (s, o) { return s + (num(o.qty) || 0); }, 0);
}
function renderGoods() {
  if (!S.loaded.products) return loadingHTML();
  var list = S.data.products.filter(function (p) { return S.admin || p.active !== false; })
    .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
  var rows = list.map(function (p) {
    var low = num(p.stock) <= LOW_STOCK, id = esc(p.id);
    var name = esc(p.name) + (p.active === false ? ' <small>(скрыт)</small>' : '');
    if (S.admin) {
      return '<tr><td><b>' + name + '</b></td>' +
        '<td><label class="sr" for="prod-' + id + '-price">Цена</label><input class="num" id="prod-' + id + '-price" type="number" inputmode="decimal" min="0" step="any" data-prod="' + id + '" data-k="price" value="' + esc(num(p.price)) + '"></td>' +
        '<td><label class="sr" for="prod-' + id + '-stock">Остаток</label><input class="num' + (low ? ' low' : '') + '" id="prod-' + id + '-stock" type="number" inputmode="numeric" step="1" data-prod="' + id + '" data-k="stock" value="' + esc(num(p.stock)) + '"></td>' +
        '<td>' + sold7(p.id) + ' шт.</td>' +
        '<td><input type="checkbox" id="prod-' + id + '-active" data-prod-active="' + id + '"' + (p.active !== false ? ' checked' : '') + ' aria-label="Продаётся"></td></tr>';
    }
    return '<tr><td><b>' + name + '</b></td><td>' + fmt(num(p.price)) + '</td><td class="' + (low ? 'low' : '') + '">' + num(p.stock) + ' шт.</td><td>' + sold7(p.id) + ' шт.</td></tr>';
  }).join('');
  var table = list.length ? '<div class="scroll"><table class="t"><thead><tr><th>Товар</th><th>Цена</th><th>Остаток</th><th>Продано за 7 дней</th>' + (S.admin ? '<th>Продаётся</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="card empty">Товаров пока нет.' + (S.admin ? ' Добавьте первый ниже.' : '') + '</div>';
  var add = S.admin ? '<div class="card"><div class="fw6 mb10">Добавить товар</div><div class="two mb12">' +
    '<div class="fld"><label for="p-name">Название</label><input id="p-name" type="text" autocomplete="off"></div>' +
    '<div class="pair"><div class="fld"><label for="p-price">Цена, ₸</label><input id="p-price" type="number" inputmode="decimal" min="0" step="any"></div>' +
    '<div class="fld"><label for="p-stock">Остаток, шт.</label><input id="p-stock" type="number" inputmode="numeric" min="0" step="1"></div></div></div>' +
    '<button type="button" class="btn pri" data-act="prod-add">Добавить товар</button></div>' : '';
  return errNotice('products') + '<div class="h1">' + (S.admin ? 'Склад и товары' : 'Товары') + '</div>' + table +
    '<small>Красным — осталось ' + LOW_STOCK + ' штук или меньше. Остаток уменьшается сам, когда заказ получает статус «Отправлен».</small>' + add;
}

function renderManagers() {
  if (!S.loaded.users) return loadingHTML();
  var list = S.data.users.slice().sort(function (a, b) { return (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1) || String(a.email).localeCompare(String(b.email)); });
  var rows = list.map(function (u) {
    var isAdmin = u.role === 'admin', me = S.user && u.email === S.user.email, id = esc(u.id);
    var acts = '';
    if (!isAdmin) {
      acts = '<span class="row-flex">' +
        '<button type="button" class="btn sm' + (u.active ? ' dng' : '') + '" data-act="user-toggle" data-id="' + id + '" data-on="' + (u.active ? '0' : '1') + '">' + (u.active ? 'Отключить' : 'Включить') + '</button>' +
        '<button type="button" class="btn sm" data-act="user-reset" data-id="' + id + '">Сбросить пароль</button></span>';
      if (S.resetFor === u.id) {
        acts += '<div class="row-flex mt8"><label class="sr" for="rp-' + id + '">Новый пароль</label><input id="rp-' + id + '" type="password" autocomplete="new-password" placeholder="Новый пароль, от 10 символов">' +
          '<button type="button" class="btn pri sm" data-act="user-reset-save" data-id="' + id + '">Сохранить</button>' +
          '<button type="button" class="btn sm" data-act="user-reset-no">Отмена</button></div>';
      }
    }
    return '<tr class="' + (u.active ? '' : 'off') + '"><td><b>' + esc(u.name || '—') + '</b>' + (me ? ' <small>(вы)</small>' : '') + '</td><td>' + esc(u.email) + '</td><td>' + (isAdmin ? 'Админ' : 'Менеджер') + '</td><td>' + (u.active ? 'активен' : 'отключён') + '</td><td>' + acts + '</td></tr>';
  }).join('');
  return errNotice('users') + '<div class="h1">Менеджеры и доступы</div>' +
    '<div class="card"><div class="two fs14"><div><b>Админ видит всё</b><div class="muted">Заказы, контент, склад, статистику и кассу, прибыль и закупку, менеджеров, бота, настройки.</div></div>' +
    '<div><b>Менеджер видит только работу</b><div class="muted">Заказы и клиентов, контент-план, остатки, номера WhatsApp и ссылку на оплату. Закупку, прибыль, кассу и настройки не видит — это закрыто на сервере.</div></div></div></div>' +
    '<div class="scroll users"><table class="t"><thead><tr><th>Имя</th><th>Почта</th><th>Роль</th><th>Доступ</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="card"><div class="fw6 mb10">Новый менеджер</div><div class="two mb12">' +
    '<div class="fld"><label for="u-login">Почта (по ней менеджер входит)</label><input id="u-login" type="email" autocomplete="off" autocapitalize="none" spellcheck="false"></div>' +
    '<div class="fld"><label for="u-name">Имя</label><input id="u-name" type="text" autocomplete="off"></div>' +
    '<div class="fld"><label for="u-pass">Пароль (от 10 символов)</label><input id="u-pass" type="password" autocomplete="new-password"></div></div>' +
    '<button type="button" class="btn pri" data-act="user-add">Создать менеджера</button>' +
    '<small class="db mt8">Передайте менеджеру почту и пароль лично. Отключённый менеджер сразу теряет доступ.</small></div>';
}

function renderBot() {
  if (!S.loaded.bot) return loadingHTML();
  var b = S.data.bot;
  if (!b) return errNotice('bot') + '<div class="h1">Бот (ИИ-менеджер)</div><div class="card empty">ИИ-менеджер ещё не подключён, появится на следующем этапе.</div>';
  var issues = Array.isArray(b.issues) ? b.issues : [];
  var k = [['Обработал обращений', b.handled], ['Оформил заказов', b.orders], ['Отправил ссылок на оплату', b.payLinks], ['Позвал человека', b.calledHuman]];
  return '<div class="h1">Бот (ИИ-менеджер)</div><div class="kpis">' + k.map(function (x, i) {
    return '<div class="card kpi kc' + (i + 1) + '"><div class="k">' + x[0] + '</div><div class="v">' + esc(x[1] == null ? 0 : x[1]) + '</div></div>';
  }).join('') + '</div><div class="card"><div class="fw6 mb6">Где бот позвал человека</div>' +
    (issues.length ? issues.map(function (i) {
      return '<div class="post-row"><div class="gap12"><b class="w52">' + esc(i.time) + '</b><div><div>' + esc(i.client) + ': «' + esc(i.question) + '»</div><small>' + esc(i.reason) + '</small></div></div></div>';
    }).join('') : '<div class="muted fs14">Пока таких случаев не было.</div>') + '</div>';
}

function renderSettings() {
  if (!S.loaded.settings) return loadingHTML();
  var s = S.data.settings || {};
  return errNotice('settings') + '<div class="h1">Настройки</div><div class="card maxw720 col14">' +
    '<div class="fld"><label for="set-wa1">WhatsApp основной</label><input id="set-wa1" type="text" inputmode="tel" autocomplete="off" value="' + esc(s.wa1) + '" placeholder="+7 ..."></div>' +
    '<div class="fld"><label for="set-wa2">WhatsApp запасной</label><input id="set-wa2" type="text" inputmode="tel" autocomplete="off" value="' + esc(s.wa2) + '" placeholder="+7 ..."></div>' +
    '<div class="fld"><label for="set-payLink">Ссылка на оплату</label><input id="set-payLink" type="text" autocomplete="off" value="' + esc(s.payLink) + '" placeholder="https://..."></div>' +
    '<div class="fld"><label for="set-templates">Шаблоны ответов</label><textarea id="set-templates">' + esc(s.templates) + '</textarea></div>' +
    '<div class="fld"><label for="set-track_msg">Шаблон сообщения с трек-номером</label><textarea id="set-track_msg" class="ta90">' + esc(s.track_msg || DEFAULT_TRACK_MSG) + '</textarea>' +
    '<small>Подставляется: {имя} — имя клиента, {трек} — трек-номер, {ссылка} — ссылка для отслеживания.</small></div>' +
    '<div class="fld"><label for="set-track_url">Ссылка для отслеживания</label><input id="set-track_url" type="text" autocomplete="off" value="' + esc(s.track_url || DEFAULT_TRACK_URL) + '" placeholder="https://.../{трек}">' +
    '<small>Должна начинаться с https:// и содержать {трек} — туда подставится номер посылки.</small></div>' +
    '<div><button type="button" class="btn pri" data-act="set-save">Сохранить</button></div></div>' +
    waServerHTML() + waNumbersHTML() + targetsHTML();
}

function renderAccount() {
  var s = S.data.settings || {};
  var contacts = [['wa1', 'WhatsApp основной'], ['wa2', 'WhatsApp запасной'], ['payLink', 'Ссылка на оплату']].map(function (x) {
    var v = s[x[0]] || '';
    var link = x[0] !== 'payLink' && waDigits(v) ? ' <a href="https://wa.me/' + waDigits(v) + '" target="_blank" rel="noopener noreferrer">открыть</a>' : '';
    return '<div class="post-row"><div><small>' + x[1] + '</small><div>' + (v ? esc(v) : '<span class="muted">не указано</span>') + link + '</div></div>' +
      (v ? '<button type="button" class="icon-btn" data-act="copy-setting" data-k="' + x[0] + '">' + COPY_SVG + 'Копировать</button>' : '') + '</div>';
  }).join('');
  return '<div class="h1">Моя почта и пароль</div><div class="two">' +
    '<div class="card"><div class="fw6 mb6">Контакты для работы</div>' + contacts + '</div>' +
    '<div class="card col12"><div class="fw6">Сменить почту для входа</div><div class="muted fs14">Сейчас: ' + esc(S.user ? S.user.email : '') + '</div>' +
    '<div class="fld"><label for="em-new">Новая почта</label><input id="em-new" type="email" autocomplete="off" autocapitalize="none"></div>' +
    '<div class="fld"><label for="em-pass">Текущий пароль</label><input id="em-pass" type="password" autocomplete="current-password"></div>' +
    '<div><button type="button" class="btn pri" data-act="email-save">Сменить почту</button></div></div>' +
    '<div class="card col12"><div class="fw6">Сменить пароль</div>' +
    '<div class="fld"><label for="pw-cur">Текущий пароль</label><input id="pw-cur" type="password" autocomplete="current-password"></div>' +
    '<div class="fld"><label for="pw-new">Новый пароль (от 10 символов)</label><input id="pw-new" type="password" autocomplete="new-password"></div>' +
    '<div class="fld"><label for="pw-new2">Новый пароль ещё раз</label><input id="pw-new2" type="password" autocomplete="new-password"></div>' +
    '<div><button type="button" class="btn pri" data-act="pw-save">Сменить пароль</button></div>' +
    '<small>После смены пароля на других устройствах нужно будет войти заново.</small></div></div>';
}

function renderView() {
  if (!S.booted) return loadingHTML();
  if (!S.auth) return renderLogin();
  var tab = S.tab;
  if (!S.admin && ADMIN_TABS[tab]) tab = S.tab = 'orders';
  switch (tab) {
    case 'summary': return renderSummary();
    case 'profit': return renderProfit();
    case 'content': return renderContent();
    case 'goods': return renderGoods();
    case 'managers': return renderManagers();
    case 'bot': return renderBot();
    case 'settings': return renderSettings();
    case 'chats': return renderChats();
    case 'account': return renderAccount();
    default: return renderOrders();
  }
}

/* ---------- render scheduling ---------- */
function fieldFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.id !== 'orders-search' && ae.id !== 'chat-search' && ae.id !== 'chat-reply' && $('#view').contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
}
// Dynamic widths are set through CSSOM (allowed by the CSP, unlike style attributes).
function applyDyn() {
  var bars = document.querySelectorAll('[data-w]');
  for (var i = 0; i < bars.length; i++) bars[i].style.width = bars[i].getAttribute('data-w') + '%';
}
function doRender(force) {
  if (!force && fieldFocused()) { S.dirty = true; return; }
  S.dirty = false;
  var ae = document.activeElement, keep = null;
  if (ae && ae.id && $('#view').contains(ae)) {
    keep = { id: ae.id, s: null, e: null };
    try { keep.s = ae.selectionStart; keep.e = ae.selectionEnd; } catch (x) { /* some input types have no selection */ }
  }
  var scrollY = window.scrollY;
  $('#view').innerHTML = renderView();
  applyDyn();
  renderHeader();
  if (S.tab === 'chats') chatsAfterRender();
  if (keep) {
    var el = document.getElementById(keep.id);
    if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch (x) { /* ignore */ } }
  }
  if (Math.abs(window.scrollY - scrollY) > 1) window.scrollTo(0, scrollY);
}
var renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(function () { renderTimer = null; doRender(false); }, 30);
}
function renderAll() { renderHeader(); renderDrawer(); doRender(true); }

/* ---------- order card ---------- */
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function extraHTML(o, st) {
  var hasSent = !!(o.delivery || o.track), delOpts = '<option value="">— выберите —</option>' + DELIVERY.map(function (d) {
    return '<option value="' + esc(d) + '"' + (d === o.delivery ? ' selected' : '') + '>' + esc(d) + '</option>';
  }).join('');
  return '<div class="xblk s-reserve' + (st === 'reserve' ? '' : ' hide') + '" id="x-reserve">' +
    '<div class="fld"><label for="f-remind">Напомнить (дата) *</label><input id="f-remind" type="date" value="' + esc(validDate(o.remindAt) ? o.remindAt : '') + '"></div>' +
    '<div class="fld"><label for="f-reserve">Причина</label><input id="f-reserve" type="text" autocomplete="off" placeholder="ждёт пенсию / пособие" value="' + esc(o.reserveNote) + '"></div>' +
    '<div class="need" id="need-reserve">Без даты напоминания резерв не сохранить.</div></div>' +
    '<div class="xblk s-sent' + (st === 'sent' || hasSent ? '' : ' hide') + '" id="x-sent">' +
    '<div class="fld"><label for="f-delivery">Служба доставки *</label><select id="f-delivery">' + delOpts + '</select></div>' +
    '<div class="fld"><label for="f-track">Трек-номер</label><input id="f-track" type="text" autocomplete="off" value="' + esc(o.track) + '"></div>' +
    '<div class="need" id="need-sent">Выберите службу доставки и впишите трек-номер (для курьера трек можно не писать).</div></div>' +
    '<div class="xblk s-cancel' + (st === 'cancel' || o.cancelNote ? '' : ' hide') + '" id="x-cancel">' +
    '<div class="fld"><label for="f-cancel">Причина отказа (необязательно)</label><input id="f-cancel" type="text" autocomplete="off" value="' + esc(o.cancelNote) + '"></div></div>';
}
function fv(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function showEl(id, on) { var e = document.getElementById(id); if (e) e.classList.toggle('hide', !on); }
// Keeps the status select, its colour and the status-dependent blocks of the open card in sync.
function syncExtra() {
  var c = S.card; if (!c) return;
  var st = c.status, o = c.orig;
  var sel = document.getElementById('card-st'), w = document.getElementById('card-stw');
  if (sel && sel.value !== st) sel.value = st;
  if (w) w.className = 'stsel big s-' + st;
  showEl('x-reserve', st === 'reserve');
  showEl('x-sent', st === 'sent' || !!(o.delivery || o.track));
  showEl('x-cancel', st === 'cancel' || !!o.cancelNote);
  showEl('need-reserve', st === 'reserve' && !validDate(fv('f-remind')));
  var dl = fv('f-delivery');
  showEl('need-sent', st === 'sent' && !(DELIVERY.indexOf(dl) >= 0 && (dl === 'Курьер' || fv('f-track').trim())));
}
function syncWa() {
  var a = document.getElementById('wa-link'); if (!a) return;
  var d = waDigits(fv('f-phone'));
  if (d) { a.setAttribute('href', 'https://wa.me/' + d); a.classList.remove('dis'); a.removeAttribute('aria-disabled'); }
  else { a.removeAttribute('href'); a.classList.add('dis'); a.setAttribute('aria-disabled', 'true'); }
}
function cardHTML() {
  var c = S.card, o = c.orig;
  var prods = S.data.products.filter(function (p) { return p.active !== false || p.id === o.productId; })
    .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
  var opts = '<option value="">— выберите товар —</option>';
  if (o.productName && !prods.some(function (p) { return p.id === o.productId; })) opts += '<option value="__keep" selected>' + esc(o.productName) + '</option>';
  prods.forEach(function (p) { opts += '<option value="' + esc(p.id) + '"' + (p.id === o.productId ? ' selected' : '') + '>' + esc(p.name) + ' — ' + fmt(num(p.price)) + '</option>'; });
  var srcs = SOURCES.slice();
  if (o.source && srcs.indexOf(o.source) < 0) srcs.push(o.source);
  var srcOpts = srcs.map(function (s) { return '<option value="' + esc(s) + '"' + (s === o.source ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
  var title = c.isNew ? 'Новый заказ' : 'Заказ № ' + esc(o.num != null ? o.num : '—');
  var info = c.isNew ? '' : '<small>Создан ' + esc(fmtDate(o.createdAt)) + (o.example ? ' · пример' : '') + '</small>' + trafficBadge(o.traffic, o.targetCode);
  var payLink = S.data.settings && S.data.settings.payLink ? '<button type="button" class="btn" data-act="copy-pay">Копировать ссылку на оплату</button>' : '';
  return '<div class="cardwrap"><div class="panel" role="dialog" aria-modal="true" aria-label="Карточка заказа">' +
    '<div class="ph"><div class="t">' + title + '</div><button type="button" class="icon-btn" id="card-close" data-act="close-card" aria-label="Закрыть">' + X_SVG + '</button></div>' +
    '<div><label class="sr" for="card-st">Статус заказа</label>' + stSelectHTML(c.status, 'id="card-st"', true) + '</div>' +
    extraHTML(o, c.status) + info +
    '<div class="fld"><label for="f-name">Имя</label><input id="f-name" type="text" autocomplete="off" value="' + esc(o.name) + '"></div>' +
    '<div class="fld"><label for="f-phone">Телефон</label><div class="phone-row"><input id="f-phone" type="text" inputmode="tel" autocomplete="off" value="' + esc(o.phone) + '"><button type="button" class="icon-btn" data-act="copy-phone">' + COPY_SVG + 'Копировать</button></div></div>' +
    '<div><a class="pill-wa" id="wa-link" target="_blank" rel="noopener noreferrer">Написать в WhatsApp</a></div>' +
    (!c.isNew && hasKzTrack(o) ? '<div class="row-flex trk-tools"><button type="button" class="btn" data-act="send-track" data-id="' + esc(o.id) + '">Отправить трек в WhatsApp</button>' +
      trackLinkHTML(o) + ' <span class="trk-ok" id="trk-mark">' + (o.trackSentAt ? 'трек отправлен ✓' : '') + '</span></div>' : '') +
    '<div class="pair"><div class="fld"><label for="f-city">Город</label><input id="f-city" type="text" autocomplete="off" value="' + esc(o.city) + '"></div>' +
    '<div class="fld"><label for="f-source">Откуда</label><select id="f-source">' + srcOpts + '</select></div></div>' +
    '<div class="fld"><label for="f-address">Адрес доставки</label><input id="f-address" type="text" autocomplete="off" value="' + esc(o.address) + '"></div>' +
    '<div class="fld"><label for="f-product">Товар</label><select id="f-product">' + opts + '</select></div>' +
    '<div class="pair"><div class="fld"><label for="f-qty">Количество</label><input id="f-qty" type="number" inputmode="numeric" min="1" step="1" value="' + esc(num(o.qty) || 1) + '"></div>' +
    '<div class="fld"><label for="f-sum">Сумма, ₸</label><input id="f-sum" type="number" inputmode="decimal" min="0" step="any" value="' + esc(num(o.sum)) + '"></div></div>' +
    '<div class="fld"><label for="f-post">С какого поста</label><input id="f-post" type="text" autocomplete="off" value="' + esc(o.post) + '"></div>' +
    '<div class="fld"><label for="f-comment">Комментарий</label><textarea id="f-comment" class="ta90">' + esc(o.comment) + '</textarea></div>' +
    '<div class="row-flex"><button type="button" class="btn pri" id="card-save" data-act="card-save">Сохранить</button>' + payLink +
    (S.admin && !c.isNew ? '<span class="grow"></span><button type="button" class="btn dng" data-act="card-del">Удалить</button>' : '') + '</div>' +
    '<div id="del-area"></div><div class="hist" id="hist"></div></div></div>';
}
// draftStatus: status picked in the table row that still needs extra fields; it is saved with the card.
function openCard(id, draftStatus) {
  var o = id ? S.data.orders.filter(function (x) { return x.id === id; })[0] : null;
  var base;
  if (o) { base = Object.assign({}, o); base.status = ostat(o); }
  else {
    base = { name: '', phone: '', city: '', address: '', productId: '', productName: '', qty: 1, sum: 0, source: 'Другое', post: '', status: 'new', track: '', comment: '' };
    var ap = activeProducts();
    if (ap.length === 1) { base.productId = ap[0].id; base.productName = ap[0].name; base.sum = num(ap[0].price); }
  }
  S.card = { id: o ? o.id : null, isNew: !o, status: draftStatus && STN[draftStatus] ? draftStatus : base.status, orig: base, busy: false };
  $('#card-root').innerHTML = cardHTML();
  syncExtra();
  syncWa();
  var cb = $('#card-close'); if (cb) cb.focus();
  if (o) loadHistory(o.id);
}
async function loadHistory(id) {
  try {
    var d = await api('GET', '/api/orders/' + encodeURIComponent(id) + '/audit');
    var el = document.getElementById('hist');
    if (!el || !S.card || S.card.id !== id) return;
    var names = { create: 'создан', lead: 'создан из комментария', status: 'статус', edit: 'изменены поля', delete: 'удалён', kazpost: 'отправлен по реестру Казпочты', track_sent: 'трек отправлен клиенту', track_unsent: 'отметка «трек отправлен» снята' };
    el.innerHTML = (d.audit || []).slice(0, 8).map(function (a) {
      var det = a.action === 'status' ? String(a.detail).split(' -> ').map(function (k) { return STN[k] || k; }).join(' → ') : '';
      return '<div>' + esc(fmtDate(a.at)) + ' · ' + esc(String(a.actor).replace(/^hook:/, 'авто: ')) + ' · ' + esc(names[a.action] || a.action) + (det ? ': ' + esc(det) : '') + '</div>';
    }).join('');
  } catch (e) { /* history is optional */ }
}
function closeCard() { S.card = null; $('#card-root').innerHTML = ''; if (S.dirty) doRender(true); }
function autofillSum() {
  var sel = $('#f-product'), id = sel ? sel.value : '';
  var p = id && id !== '__keep' ? findProduct(id) : null;
  if (!p) return;
  var q = Math.max(1, Math.round(num($('#f-qty').value)) || 1);
  $('#f-sum').value = String(num(p.price) * q);
}
function readForm() {
  var g = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
  var d = {
    name: g('f-name').trim(), phone: g('f-phone').trim(), city: g('f-city').trim(), address: g('f-address').trim(),
    qty: Math.max(1, Math.round(num(g('f-qty'))) || 1), sum: Math.max(0, num(g('f-sum'))),
    source: g('f-source'), post: g('f-post').trim(), track: g('f-track').trim(), comment: g('f-comment').trim(),
    delivery: g('f-delivery'), remindAt: g('f-remind'), reserveNote: g('f-reserve').trim(), cancelNote: g('f-cancel').trim()
  };
  var pid = g('f-product');
  if (pid !== '__keep') d.productId = pid;
  return d;
}

/* ---------- card actions ---------- */
function latestOrder(c) { return S.data.orders.filter(function (x) { return x.id === c.id; })[0] || c.orig; }
// Returns {msg, id} when the status needs fields that are missing.
function validateStatus(c, f) {
  var st = c.status;
  if (st === 'reserve' && !validDate(f.remindAt)) return { msg: 'для резерва укажите дату «Напомнить»', id: 'f-remind' };
  if (st === 'sent' && (c.isNew || st !== c.orig.status)) {
    if (DELIVERY.indexOf(f.delivery) < 0) return { msg: 'выберите службу доставки', id: 'f-delivery' };
    if (f.delivery !== 'Курьер' && !f.track) return { msg: 'впишите трек-номер', id: 'f-track' };
  }
  return null;
}
async function cardStatus(st) {
  var c = S.card;
  if (!c || c.busy || !STN[st]) { syncExtra(); return; }
  // New orders and statuses with required fields are only a draft until «Сохранить».
  if (c.isNew || NEEDS[st]) { c.status = st; syncExtra(); return; }
  var cur = latestOrder(c);
  if (ostat(cur) === st) { c.status = st; syncExtra(); return; }
  c.busy = true;
  var ok = await run('Статус: ' + STN[st], function () { return api('PATCH', '/api/orders/' + c.id, { status: st }); });
  c.busy = false;
  if (ok) { c.status = st; c.orig = Object.assign({}, c.orig, { status: st }); await load('orders'); loadHistory(c.id); }
  if (S.card === c) syncExtra();
}
// Table row: change the status without opening the card (except statuses that need extra fields).
async function rowStatus(sel) {
  var id = sel.dataset.ost, st = sel.value;
  var o = S.data.orders.filter(function (x) { return x.id === id; })[0];
  if (!o || !STN[st] || ostat(o) === st) return;
  sel.blur();
  if (NEEDS[st]) { openCard(id, st); doRender(true); return; }
  await run('Заказ № ' + o.num + ': ' + STN[st], function () { return api('PATCH', '/api/orders/' + id, { status: st }); });
  await load('orders');
  doRender(true);
}
async function saveCard() {
  var c = S.card;
  if (!c || c.busy) return;
  var f = readForm();
  if (!f.name && !f.phone) { toast('Не сохранилось: укажите имя или телефон', 'err'); return; }
  var bad = validateStatus(c, f);
  if (bad) {
    toast('Не сохранилось: ' + bad.msg, 'err');
    var fe = document.getElementById(bad.id); if (fe) { try { fe.focus(); } catch (x) { /* ignore */ } }
    return;
  }
  c.busy = true;
  var btn = $('#card-save'); if (btn) btn.disabled = true;
  var ok = false;
  if (c.isNew) {
    var body = Object.assign({}, f, { status: c.status });
    ok = await run('Заказ создан', function () { return api('POST', '/api/orders', body); });
  } else {
    var patch = {}, o = c.orig;
    Object.keys(f).forEach(function (k) {
      var a = f[k], b = o[k];
      var same = (k === 'qty' || k === 'sum') ? num(a) === num(b) : String(a == null ? '' : a) === String(b == null ? '' : b);
      if (!same) patch[k] = a;
    });
    if (c.status !== o.status) patch.status = c.status;
    if (!Object.keys(patch).length) { toast('Изменений нет', 'ok'); c.busy = false; if (btn) btn.disabled = false; return; }
    ok = await run('Сохранено', function () { return api('PATCH', '/api/orders/' + c.id, patch); });
  }
  c.busy = false;
  if (ok) { await load('orders'); if (S.tab === 'goods' || S.tab === 'profit') await load('products'); closeCard(); doRender(true); }
  else if (btn) btn.disabled = false;
}
function showDelConfirm() {
  var c = S.card; if (!c) return;
  $('#del-area').innerHTML = '<div class="confirm"><div><b>Удалить заказ № ' + esc(c.orig.num) + '?</b> Это нельзя отменить.</div>' +
    '<div class="row-flex"><button type="button" class="btn dngf" data-act="card-del-yes">Да, удалить</button><button type="button" class="btn" data-act="card-del-no">Отмена</button></div></div>';
}
async function deleteCard() {
  var c = S.card; if (!c || c.busy) return;
  c.busy = true;
  var ok = await run('Заказ удалён', function () { return api('DELETE', '/api/orders/' + c.id); });
  c.busy = false;
  if (ok) { await load('orders'); closeCard(); doRender(true); }
}

/* ---------- clipboard ---------- */
function copyText(text, okMsg, inputId) {
  var fail = function () {
    var el = inputId ? document.getElementById(inputId) : null;
    if (el) { try { el.focus(); el.select(); } catch (x) { /* ignore */ } }
    toast('Не удалось скопировать — выделите текст и скопируйте вручную', 'err');
  };
  if (!text) { toast('Нечего копировать', 'err'); return; }
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fail(); return; }
    navigator.clipboard.writeText(text).then(function () { toast(okMsg, 'ok'); }).catch(fail);
  } catch (e) { fail(); }
}

// Copies text synchronously inside the click (so the focus is still on the page), falls back to the async clipboard API.
function copyToClipboard(text) {
  var ok = false, prev = document.activeElement;
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (prev && prev.focus) prev.focus();
  } catch (e) { ok = false; }
  if (ok) return Promise.resolve(true);
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
  return Promise.resolve(false);
}

/* ---------- Kazpost registry import ---------- */
function orderOpt(c, sel) {
  return '<option value="' + esc(c.id) + '"' + (sel ? ' selected' : '') + '>№ ' + esc(c.num) + ' · ' + esc(c.name || 'Без имени') + (c.city ? ' · ' + esc(c.city) : '') + '</option>';
}
function kzFound() { return S.kz.items.filter(function (r) { return r.orderId; }).length; }
function kzRowHTML(r, i) {
  var who = '<b>' + esc(r.name || '—') + '</b><small>' + esc(r.address || '') + '</small>';
  if (r.already) {
    return '<div class="kzrow done"><div class="kz-trk">' + esc(r.track) + '<small>уже отправлен</small></div><div class="kz-reg">' + who +
      '</div><div class="kz-ord">№ ' + esc(r.match ? r.match.num : '') + ' · ' + esc(r.match ? r.match.name : '') + '</div></div>';
  }
  var cands = S.kz.candidates, has = {};
  var opts = '<option value="">— пропустить —</option>' + cands.map(function (c) { has[c.id] = 1; return orderOpt(c, c.id === r.orderId); }).join('');
  if (r.match && !has[r.match.id]) opts += orderOpt(r.match, r.match.id === r.orderId);
  var crm = r.orderId ? ('<small class="kz-arrow">→ ' + esc(kzOrderLabel(r.orderId)) + '</small>') : '';
  return '<div class="kzrow ' + (r.orderId ? 'ok' : 'no') + '"><div class="kz-trk">' + esc(r.track) + '<small>' + esc(r.orderId ? r.reason : 'не найден') + '</small></div>' +
    '<div class="kz-reg">' + who + crm + '</div>' +
    '<div class="kz-ord"><label class="sr" for="kz-sel-' + i + '">Заказ для посылки ' + esc(r.track) + '</label><select id="kz-sel-' + i + '" data-kz="' + i + '">' + opts + '</select></div></div>';
}
function kzOrderLabel(id) {
  var c = S.kz.candidates.filter(function (x) { return x.id === id; })[0];
  if (!c) { c = S.kz.items.map(function (r) { return r.match; }).filter(function (m) { return m && m.id === id; })[0]; }
  return c ? '№ ' + c.num + ' · ' + (c.name || 'Без имени') : '';
}
function kzSentCount() {
  var n = 0;
  S.kz.result.applied.forEach(function (a) { var o = S.data.orders.filter(function (x) { return x.id === a.orderId; })[0]; if (o && o.trackSentAt) n++; });
  return n;
}
function kzPanelHTML() {
  var k = S.kz;
  if (!k) return '';
  var head = function (title) {
    return '<div class="row-flex"><div class="fw6">' + title + '</div><span class="grow"></span><button type="button" class="btn sm" data-act="kz-close">Закрыть</button></div>';
  };
  if (k.phase === 'read') return '<div class="card kz col12">' + head('Реестр Казпочты') + '<div class="muted">Читаем файл ' + esc(k.fileName) + '…</div></div>';
  if (k.phase === 'preview') {
    var n = kzFound();
    return '<div class="card kz col12">' + head('Реестр Казпочты: найдено <b>' + n + '</b> из ' + k.items.length) +
      (k.skippedBlocks ? '<div class="notice">Не удалось разобрать посылок: ' + k.skippedBlocks + '. Проверьте файл.</div>' : '') +
      '<small>Файл: ' + esc(k.fileName) + (k.total ? ' · сумма в реестре ' + fmt(k.total) : '') + '. Проверьте пары и при необходимости выберите заказ вручную или «пропустить».</small>' +
      '<div class="kzlist">' + k.items.map(kzRowHTML).join('') + '</div>' +
      '<div class="row-flex"><button type="button" class="btn pri" data-act="kz-apply"' + (n && !k.busy ? '' : ' disabled') + '>Отметить отправленными (' + n + ')</button>' +
      '<button type="button" class="btn" data-act="kz-close">Отмена</button></div></div>';
  }
  var res = k.result, rows = res.applied.map(function (a) {
    var o = S.data.orders.filter(function (x) { return x.id === a.orderId; })[0];
    if (!o) return '';
    return '<div class="kzrow send"><div class="kz-trk">№ ' + esc(o.num) + '<small>' + esc(a.track) + '</small></div>' +
      '<div class="kz-reg"><b>' + esc(o.name || 'Без имени') + '</b><small>' + esc(o.city || '') + '</small></div>' +
      '<div class="kz-ord row-flex"><button type="button" class="btn' + (o.trackSentAt ? '' : ' pri') + '" data-act="send-track" data-id="' + esc(o.id) + '">' +
      (o.trackSentAt ? 'Отправить ещё раз' : 'Отправить трек в WhatsApp') + '</button>' + (o.trackSentAt ? '<span class="trk-ok">трек отправлен ✓</span>' : '') + '</div></div>';
  }).join('');
  var notes = (res.already ? '<div class="muted fs14">Уже были отправлены раньше: ' + res.already + '.</div>' : '') +
    res.skipped.map(function (x) { return '<div class="notice">Посылка ' + esc(x.track) + (x.num ? ' (заказ № ' + esc(x.num) + ')' : '') + ' пропущена: ' + esc(x.reason) + '.</div>'; }).join('');
  return '<div class="card kz col12">' + head('Отправлено: <b>' + res.sent + '</b>') + notes +
    (res.applied.length ? '<div class="fw6 mt8">Разослать треки <span class="kz-count">отправлено ' + kzSentCount() + ' из ' + res.applied.length + '</span></div>' +
      '<small>Кнопка копирует текст и открывает чат WhatsApp клиента: вставьте текст и отправьте.</small><div class="kzlist">' + rows + '</div>' : '') + '</div>';
}
async function kzLoadFile(input) {
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { toast('Файл слишком большой (больше 10 МБ)', 'err'); return; }
  if (!window.Kazpost) { toast('Модуль чтения реестра не загрузился. Обновите страницу.', 'err'); return; }
  S.kz = { phase: 'read', fileName: f.name }; doRender(true);
  try {
    var text = await window.Kazpost.extractPdfText(await f.arrayBuffer());
    var parsed = window.Kazpost.parseKazpostDetailed(text);
    if (!parsed.items.length) throw new Error('в файле не найдено ни одной посылки. Это точно реестр Казпочты в PDF?');
    var d = await api('POST', '/api/kazpost/preview', { items: parsed.items });
    S.kz = {
      phase: 'preview', fileName: f.name, total: parsed.total, skippedBlocks: parsed.skipped, candidates: d.candidates || [], busy: false,
      items: d.items.map(function (r) { return Object.assign({}, r, { orderId: r.match && !r.already ? r.match.id : '' }); })
    };
  } catch (e) {
    S.kz = null;
    toast('Не удалось прочитать реестр: ' + (e.message || 'ошибка файла'), 'err');
  }
  doRender(true);
}
async function kzApply() {
  var k = S.kz;
  if (!k || k.phase !== 'preview' || k.busy) return;
  var pairs = [], seen = {}, dup = null;
  k.items.forEach(function (r) {
    if (!r.orderId || r.already) return;
    if (seen[r.orderId]) dup = r.orderId;
    seen[r.orderId] = 1;
    pairs.push({ track: r.track, orderId: r.orderId });
  });
  if (!pairs.length) { toast('Не выбрано ни одного заказа', 'err'); return; }
  if (dup) { toast('Один заказ выбран для двух посылок: ' + kzOrderLabel(dup), 'err'); return; }
  if (!window.confirm('Отметить отправленными заказы: ' + pairs.length + '? Статус станет «Отправлен», остаток на складе уменьшится.')) return;
  k.busy = true; doRender(true);
  try {
    var d = await api('POST', '/api/kazpost/apply', { pairs: pairs });
    S.kz = { phase: 'done', result: { sent: d.sent, already: d.already, skipped: d.skipped || [], applied: d.applied || [] } };
    await Promise.all([load('orders'), load('products')]);
    toast('Отправлено: ' + d.sent, 'ok');
  } catch (e) {
    k.busy = false;
    toast('Не сохранилось: ' + e.message, 'err');
  }
  doRender(true);
}
function sendTrack(id) {
  var o = S.data.orders.filter(function (x) { return x.id === id; })[0];
  if (!o || !o.track) { toast('У заказа нет трек-номера', 'err'); return; }
  var wa = waDigits(o.phone);
  if (!wa) { toast('У заказа нет номера для WhatsApp', 'err'); return; }
  var text = trackMessage(o);
  var copied = copyToClipboard(text); // copy first (while the page has focus), then open the chat: no text in the link
  window.open('https://wa.me/' + wa, '_blank', 'noopener');
  copied.then(function (ok) {
    if (!ok) { toast('Не удалось скопировать — скопируйте текст вручную', 'err'); window.prompt('Скопируйте текст сообщения', text); return null; }
    toast('Текст скопирован — вставьте в чат', 'ok');
    return api('POST', '/api/orders/' + encodeURIComponent(id) + '/track-sent', { sent: true }).then(function (d) {
      o.trackSentAt = d.trackSentAt || nowISO();
      var mark = document.getElementById('trk-mark'); if (mark && S.card && S.card.id === id) mark.textContent = 'трек отправлен ✓';
      doRender(true);
    });
  }).catch(function (e) { toast('Текст скопирован, но отметка не сохранилась: ' + e.message, 'err'); });
}

/* ---------- Inbox: chats ---------- */
function freshChat() {
  return { list: [], unreadTotal: 0, filter: 'all', q: '', openId: null, thread: null, draft: '', sending: false, loaded: false, error: '', seq: 0, sig: '', rec: null };
}
var chatSearchTimer = null;
var CHAT_FILTERS = [['all', 'Все'], ['unread', 'Непрочитанные'], ['target', 'Таргет'], ['organic', 'Органика'], ['old', 'Старые']];

function trafficBadge(traffic, code) {
  if (traffic === 'target') return ' <span class="badge b-tr tb-t">Таргет' + (code ? ' · ' + esc(code) : '') + '</span>';
  if (traffic === 'organic') return ' <span class="badge b-tr tb-o">Органика</span>';
  return '';
}
function chatSrcBadge(c) {
  if (c.traffic === 'target') {
    var label = 'Таргет' + (c.productName ? ' · ' + c.productName : '') + (c.targetCode ? ' (' + c.targetCode + ')' : '');
    return '<span class="badge b-tr tb-t"' + (c.platform ? ' title="' + esc(c.platform) + '"' : '') + '>' + esc(label) + '</span>';
  }
  if (c.traffic === 'old') return '<span class="badge b-tr tb-old">Старый</span>';
  return '<span class="badge b-tr tb-o">Органика</span>';
}
function chatName(c) { return c.name || (c.phone ? '+' + c.phone : c.idKind === 'lid' ? 'Номер скрыт WhatsApp' : 'Без имени'); }
function chatTime(iso) {
  var p = almaty(iso), t = todayP();
  if (!p || !t) return '';
  var diff = t.dn - p.dn;
  if (diff === 0) return pad2(p.h) + ':' + pad2(p.mi);
  if (diff === 1) return 'вчера';
  return p.d + ' ' + MONTHS[p.m - 1];
}

function chatRowsHTML() {
  var C = S.chat;
  if (!C.loaded) return '<div class="empty">Загружаем…</div>';
  if (C.error) return '<div class="notice">Не загрузилось: ' + esc(C.error) + '</div>';
  if (!C.list.length) return '<div class="empty">' + (C.q || C.filter !== 'all' ? 'Ничего не найдено.' : 'Чатов пока нет. Они появятся, когда клиенты напишут на подключённый номер WhatsApp.') + '</div>';
  return C.list.map(function (c) {
    return '<button type="button" class="crow' + (C.openId === c.id ? ' on' : '') + (c.unread ? ' unr' : '') + '" data-act="chat-open" data-id="' + c.id + '">' +
      '<span class="cr1"><b>' + esc(chatName(c)) + '</b><small>' + esc(chatTime(c.lastAt)) + '</small></span>' +
      '<span class="cr2"><span class="prev">' + esc(c.preview || '') + '</span>' + (c.unread ? '<span class="ubadge">' + esc(c.unread) + '</span>' : '') + '</span>' +
      '<span class="cr3">' + chatSrcBadge(c) + (c.numberLabel ? ' <small>' + esc(c.numberLabel) + (c.numberStatus === 'blocked' ? ' (заблокирован)' : '') + '</small>' : '') + '</span></button>';
  }).join('');
}

function noMedia(label, m) { return '<i>' + (m.body ? esc(m.body) : label + ' (вложение недоступно)') + '</i>'; }
var OUT_STATUS = { queued: ' · в очереди', sent: ' · отправлено', delivered: ' · доставлено', read: ' · прочитано', failed: ' · ошибка' };
function bubbleHTML(m) {
  var url = '/api/media/' + m.id, body;
  var media = m.hasMedia;
  switch (m.type) {
    case 'text': body = esc(m.body); break;
    case 'image':
      body = media ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer"><img class="mimg" loading="lazy" src="' + url + '" alt="Фото"></a>' : noMedia('Фото', m);
      if (m.caption) body += '<div>' + esc(m.caption) + '</div>';
      break;
    case 'sticker': body = media ? '<img class="mimg stk" loading="lazy" src="' + url + '" alt="Стикер">' : noMedia('Стикер', m); break;
    case 'voice': case 'audio':
      body = media ? '<div class="mlbl">' + (m.type === 'voice' ? 'Голосовое сообщение' : 'Аудио') + '</div><audio controls preload="metadata" src="' + url + '"></audio>'
        : noMedia(m.type === 'voice' ? 'Голосовое' : 'Аудио', m);
      break;
    case 'video': case 'document':
      body = (media ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + (m.type === 'video' ? 'Видео' : 'Файл') + (m.type === 'document' && m.caption ? ': ' + esc(m.caption) : '') + ' — открыть</a>'
        : noMedia(m.type === 'video' ? 'Видео' : 'Файл', m) + (m.type === 'document' && m.caption ? '<div>' + esc(m.caption) + '</div>' : ''));
      if (m.type === 'video' && m.caption) body += '<div>' + esc(m.caption) + '</div>';
      break;
    case 'location': body = 'Геолокация: ' + esc(m.body); break;
    case 'reaction': body = 'Реакция: ' + esc(m.body); break;
    default: body = '<i>Сообщение, которое CRM не показывает. Посмотрите его в приложении WhatsApp.</i>';
  }
  var st = m.direction === 'out' ? (OUT_STATUS[m.status] || '') : '';
  return '<div class="msg ' + (m.direction === 'out' ? 'out' : 'in') + '"><div class="bub' + (m.status === 'failed' && m.direction === 'out' ? ' mfail' : '') + '">' + body +
    '<div class="mmeta">' + esc(fmtDate(m.ts)) + (m.fromApp ? ' · с телефона' : '') + (m.status === 'failed' && m.direction === 'out' ? '<b class="neg">' + st + '</b>' : st) + '</div></div></div>';
}
function chatMsgsHTML() {
  var th = S.chat.thread;
  if (!th) return '<div class="empty">Загружаем…</div>';
  return olderHTML(th) + (th.messages.length ? th.messages.map(bubbleHTML).join('') : '<div class="empty">' + (th.chat.historyDone ? 'Старые сообщения есть только на телефоне.' : 'Сообщений нет.') + '</div>');
}
// Top of the thread: «Загрузить более ранние сообщения» (the phone is asked for a page before the oldest message, like WhatsApp Web).
// Disabled with «Загружаю…» while the request is pending; hidden when the phone has nothing older.
function olderHTML(th) {
  var c = th.chat;
  if (c.channel !== 'whatsapp' || c.historyDone) return '';
  var busy = !!(c.historyPending || S.chat.olderBusy === c.id);
  return '<div class="chat-older"><button type="button" class="btn sm" id="chat-older" data-act="chat-older"' + (busy ? ' disabled' : '') + '>' +
    (busy ? 'Загружаю…' : 'Загрузить более ранние сообщения') + '</button></div>';
}
async function chatOlder() {
  var C = S.chat, id = C.openId;
  if (id == null || C.olderBusy === id) return;
  C.olderBusy = id;
  var b = $('#chat-older'); if (b) { b.disabled = true; b.textContent = 'Загружаю…'; }
  try {
    await api('POST', '/api/chats/' + id + '/older', {});
    await chatsRefreshThread();      // shows «Загружаю…» from the server state; the polling brings the messages when the phone answers
  } catch (e) {
    toast(e.message, 'err');
  }
  if (C.olderBusy === id) C.olderBusy = null;
  if (C.openId === id && S.tab === 'chats') chatsPaintMessages();
}
function chatSourceOptions(c) {
  var cur = c.traffic === 'target' ? 'target:' + (c.targetCode || '') : c.traffic;
  var opts = [['organic', 'Органика'], ['old', 'Старый клиент'], ['target:', 'Таргет (товар не определён)']];
  S.data.targets.forEach(function (tg) { opts.push(['target:' + tg.code, 'Таргет · ' + (tg.productName || 'без названия') + ' (' + tg.code + ')']); });
  if (opts.every(function (o) { return o[0] !== cur; })) opts.push([cur, 'Таргет · ' + (c.productName || '') + ' (' + c.targetCode + ')']);
  return opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
}
function chatHeadHTML() {
  var th = S.chat.thread;
  if (!th) return '';
  var c = th.chat;
  var order = c.orderId
    ? '<button type="button" class="btn" data-act="chat-order-open" data-id="' + esc(c.orderId) + '">Открыть заказ № ' + esc(c.orderNum != null ? c.orderNum : '') + '</button>'
    : '<button type="button" class="btn pri" data-act="chat-order">Оформить заказ</button>';
  return '<div class="row-flex"><button type="button" class="btn sm only-narrow" data-act="chat-back">&larr; Чаты</button>' +
    '<div class="grow1"><b>' + esc(chatName(c)) + '</b> <small>' + (c.name && c.phone ? '+' + esc(c.phone) : c.name && c.idKind === 'lid' ? 'номер скрыт WhatsApp' : '') + '</small><div>' + chatSrcBadge(c) +
    (c.platform ? ' <small>' + esc(c.platform) + '</small>' : '') + (c.numberLabel ? ' <small>номер: ' + esc(c.numberLabel) + (c.numberStatus === 'blocked' ? ' (заблокирован)' : c.numberStatus === 'off' ? ' (выключен)' : '') + '</small>' : '') + '</div></div></div>' +
    '<div class="row-flex"><label class="sr" for="chat-src">Источник</label><select id="chat-src" class="chat-src">' + chatSourceOptions(c) + '</select>' + order + '</div>';
}
var MIC_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
var IMG_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-9 9"/></svg>';
function fmtSecs(n) { return Math.floor(n / 60) + ':' + pad2(n % 60); }
function recHTML(R) {
  if (R.mode === 'recording') {
    return '<div class="chat-rec"><span class="rec-dot" aria-hidden="true"></span><span>Идёт запись <b id="rec-time">' + fmtSecs(R.secs) + '</b> из 2:00</span>' +
      '<button type="button" class="btn pri" data-act="rec-stop">Остановить</button><button type="button" class="btn" data-act="rec-cancel">Отмена</button></div>';
  }
  return '<div class="chat-rec"><audio controls preload="auto" src="' + esc(R.url) + '"></audio>' +
    '<button type="button" class="btn pri" id="rec-send" data-act="rec-send"' + (R.sending ? ' disabled' : '') + '>Отправить</button>' +
    '<button type="button" class="btn" data-act="rec-cancel"' + (R.sending ? ' disabled' : '') + '>Отмена</button></div>';
}
function chatComposerHTML() {
  var th = S.chat.thread;
  if (!th) return '';
  var c = th.chat, notes = '', qr = c.numberConnection === 'qr';
  if (!S.waConnected) notes += '<div class="notice">WhatsApp ещё не подключён: переписка видна, но отправить сообщение из CRM пока нельзя.</div>';
  if (c.numberStatus === 'blocked') notes += '<div class="notice">Номер, на который писал клиент, заблокирован. Ответьте из приложения WhatsApp или с запасного номера.</div>';
  else if (c.numberStatus === 'off') notes += '<div class="notice">Номер, на который писал клиент, выключен в настройках.</div>';
  var last = Date.parse(c.lastInboundAt || '');
  if (!qr && (!last || Date.now() - last > 24 * 3600e3)) notes += '<div class="notice">Прошло больше 24 часов с последнего сообщения клиента — WhatsApp не даёт отправить обычное сообщение. Напишите из приложения на телефоне.</div>';
  var R = S.chat.rec;
  if (R) return notes + '<div class="notice hide" id="chat-err" role="alert"></div>' + recHTML(R);
  var tools = qr ? '<button type="button" class="icon-btn" data-act="rec-start" aria-label="Записать голосовое" title="Голосовое сообщение">' + MIC_SVG + '</button>' +
    '<button type="button" class="icon-btn" data-act="chat-attach" aria-label="Прикрепить фото" title="Фото">' + IMG_SVG + '</button>' +
    '<input type="file" id="chat-img" class="hide" accept="image/jpeg,image/png,image/webp" aria-label="Фото для отправки">' : '';
  return notes + '<div class="notice hide" id="chat-err" role="alert"></div>' +
    '<div class="chat-compose">' + tools + '<label class="sr" for="chat-reply">Ответ клиенту</label><textarea id="chat-reply" rows="2" placeholder="Ответ клиенту (Ctrl+Enter — отправить)">' + esc(S.chat.draft) + '</textarea>' +
    '<button type="button" class="btn pri" id="chat-send" data-act="chat-send"' + (S.chat.sending ? ' disabled' : '') + '>Отправить</button></div>';
}
function chatThreadHTML() {
  var C = S.chat;
  if (C.openId == null) return '<div class="empty">Выберите чат слева.</div>';
  return '<div class="chat-head" id="chat-head">' + chatHeadHTML() + '</div><div class="chat-msgs" id="chat-msgs">' + chatMsgsHTML() + '</div><div class="chat-foot" id="chat-foot">' + chatComposerHTML() + '</div>';
}
function renderChats() {
  if (!S.chat) S.chat = freshChat();
  var C = S.chat;
  var chips = CHAT_FILTERS.map(function (f) {
    return '<button type="button" class="chip' + (C.filter === f[0] ? ' on' : '') + '" data-act="chat-filter" data-f="' + f[0] + '">' + f[1] + '</button>';
  }).join('');
  return '<div class="chats' + (C.openId != null ? ' thread-open' : '') + '" id="chats">' +
    '<div class="card chat-list"><div class="chat-tools"><div class="row-flex chat-chips">' + chips + '</div>' +
    '<label class="sr" for="chat-search">Поиск по чатам</label><input id="chat-search" type="search" placeholder="Поиск: имя, телефон, текст" value="' + esc(C.q) + '" autocomplete="off"></div>' +
    '<div id="chat-rows">' + chatRowsHTML() + '</div></div>' +
    '<div class="card chat-thread" id="chat-thread">' + chatThreadHTML() + '</div></div>';
}
function chatsAfterRender() {
  var el = $('#chat-msgs');
  if (el) el.scrollTop = el.scrollHeight;
  if (!S.chat.loaded && !S.chat.loading) chatsEnter();
}

function chatsPaintList() { var el = $('#chat-rows'); if (el) el.innerHTML = chatRowsHTML(); }
function chatsPaintThread() {
  var el = $('#chat-thread'), root = $('#chats');
  if (root) root.classList.toggle('thread-open', S.chat.openId != null);
  if (el) { el.innerHTML = chatThreadHTML(); var m = $('#chat-msgs'); if (m) m.scrollTop = m.scrollHeight; }
}
// Repaints the messages and header without touching the reply box (the owner may be typing).
function chatsPaintMessages() {
  var box = $('#chat-msgs'), head = $('#chat-head'), foot = $('#chat-foot');
  if (!box) return;
  var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  var fromBottom = box.scrollHeight - box.scrollTop;
  var th = S.chat.thread, first = th && th.messages.length ? th.messages[0].id : null;
  // older messages were inserted above: keep the same message under the eyes (the distance to the bottom stays the same)
  var prepended = first != null && S.chat.firstId != null && S.chat.firstOpen === S.chat.openId && first !== S.chat.firstId;
  S.chat.firstId = first; S.chat.firstOpen = S.chat.openId;
  box.innerHTML = chatMsgsHTML();
  if (head) head.innerHTML = chatHeadHTML();
  if (foot && !foot.contains(document.activeElement) && !S.chat.rec) foot.innerHTML = chatComposerHTML();
  if (prepended) box.scrollTop = box.scrollHeight - fromBottom;
  else if (stick) box.scrollTop = box.scrollHeight;
}
async function chatsLoadList() {
  var C = S.chat, my = ++C.seq;
  var qs = '?filter=' + encodeURIComponent(C.filter) + (C.q.trim() ? '&q=' + encodeURIComponent(C.q.trim()) : '');
  try {
    var d = await api('GET', '/api/chats' + qs);
    if (my !== C.seq) return;
    C.list = d.chats || []; C.unreadTotal = d.unreadTotal || 0; C.error = '';
  } catch (e) {
    if (e.status === 401 || my !== C.seq) return;
    C.error = e.message;
  }
  C.loaded = true; C.loading = false;
  if (S.tab === 'chats') chatsPaintList();
  renderHeader();
}
async function chatsCount() {
  if (!S.auth || !S.chat) return;
  try { var d = await api('GET', '/api/chats?count=1'); S.chat.unreadTotal = d.unreadTotal || 0; renderHeader(); } catch (e) { /* the badge is optional */ }
}
function chatsEnter() {
  S.chat.loading = true;
  load('targets').then(function () { if (S.chat.thread && S.tab === 'chats') { var h = $('#chat-head'); if (h) h.innerHTML = chatHeadHTML(); } });
  chatsLoadList();
}
async function chatsRefreshThread() {
  var C = S.chat, id = C.openId;
  if (id == null) return;
  try {
    var d = await api('GET', '/api/chats/' + id);
    if (C.openId !== id) return;
    var sig = JSON.stringify([d.messages.map(function (m) { return m.id + m.status; }), d.chat.traffic, d.chat.targetCode, d.chat.orderId, d.chat.numberStatus, d.chat.historyPending, d.chat.historyDone]);
    C.thread = d;
    if (sig !== C.sig) { C.sig = sig; if (S.tab === 'chats') chatsPaintMessages(); }
  } catch (e) { /* keep the old thread; the next poll retries */ }
}
async function chatOpen(id) {
  var C = S.chat;
  recCancel(true);
  C.openId = id; C.thread = null; C.draft = ''; C.sig = '';
  C.list.forEach(function (c) { if (c.id === id) c.unread = 0; });
  chatsPaintList(); chatsPaintThread();
  window.scrollTo(0, 0);
  try {
    var d = await api('GET', '/api/chats/' + id);
    if (C.openId !== id) return;
    C.thread = d; C.sig = '';
    C.firstId = d.messages.length ? d.messages[0].id : null; C.firstOpen = id;
    chatsPaintThread();
    chatsCount();
  } catch (e) { toast('Не открылось: ' + e.message, 'err'); }
}
function chatBack() { recCancel(true); S.chat.openId = null; S.chat.thread = null; chatsPaintList(); chatsPaintThread(); chatsLoadList(); }
function showChatErr(msg) { var e = $('#chat-err'); if (e) { e.textContent = msg || ''; e.classList.toggle('hide', !msg); } }
async function chatSend() {
  var C = S.chat, id = C.openId, text = C.draft.trim();
  if (id == null || !text || C.sending) return;
  C.sending = true; showChatErr('');
  var btn = $('#chat-send'); if (btn) btn.disabled = true;
  try {
    var d = await api('POST', '/api/chats/' + id + '/send', { text: text });
    C.sending = false;
    if (C.openId !== id) return;
    C.draft = ''; var ta = $('#chat-reply'); if (ta) ta.value = '';
    if (C.thread && d.message) { C.thread.messages.push(d.message); C.sig = ''; }
    chatsPaintMessages();
    chatsLoadList();
    if (d.warning) showChatErr(d.warning);
  } catch (e) {
    C.sending = false;
    if (btn) btn.disabled = false;
    showChatErr(e.message);
  }
}
/* ----- voice notes (MediaRecorder) and photos from the chat ----- */
var MAX_REC_SECS = 120, MAX_FILE_BYTES = 1.5 * 1024 * 1024;
function repaintFoot() { var f = $('#chat-foot'); if (f) f.innerHTML = chatComposerHTML(); }
function recRelease(R) {
  if (!R) return;
  clearInterval(R.timer);
  if (R.stream) R.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (x) { /* ignore */ } });
  if (R.url) { try { URL.revokeObjectURL(R.url); } catch (x) { /* ignore */ } }
}
function recCancel(silent) {
  var C = S.chat, R = C && C.rec;
  if (!R) return;
  R.cancelled = true;
  if (R.mode === 'recording' && R.recorder && R.recorder.state !== 'inactive') { try { R.recorder.stop(); } catch (x) { /* ignore */ } }
  recRelease(R);
  C.rec = null;
  if (!silent) repaintFoot();
}
async function recStart() {
  var C = S.chat;
  if (C.rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('Этот браузер не умеет записывать звук', 'err'); return; }
  var stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('Нет доступа к микрофону. Разрешите его в настройках браузера для этого сайта.', 'err'); return; }
  var mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
  var rec;
  try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); toast('Не удалось начать запись', 'err'); return; }
  var R = { mode: 'recording', chunks: [], mime: rec.mimeType || mime || 'audio/webm', secs: 0, started: Date.now(), stream: stream, recorder: rec, timer: null, url: '', blob: null, cancelled: false, sending: false };
  rec.ondataavailable = function (e) { if (e.data && e.data.size) R.chunks.push(e.data); };
  rec.onstop = function () {
    clearInterval(R.timer);
    R.stream.getTracks().forEach(function (t) { t.stop(); });
    if (R.cancelled || C.rec !== R) return;
    var raw = new Blob(R.chunks, { type: R.mime });
    if (!raw.size) { C.rec = null; repaintFoot(); toast('Запись получилась пустой', 'err'); return; }
    // Chrome records WebM/Opus; WhatsApp wants Ogg/Opus. Repack in the browser (no re-encoding, nothing to install on the connector's computer).
    var done = function (blob) {
      if (R.cancelled || C.rec !== R) return;
      R.blob = blob;
      R.url = URL.createObjectURL(R.blob); R.mode = 'preview';
      repaintFoot();
      // Duration and waveform for the WhatsApp voice bubble (without them it shows a flat line); sending works without them too.
      if (window.Wave) window.Wave.analyseBlob(blob).then(function (w) { if (w) R.wave = w; }, function () { /* optional */ });
    };
    if (window.OggMux) window.OggMux.toOggBlob(raw).then(done, function () { done(raw); });
    else done(raw);
  };
  R.timer = setInterval(function () {
    R.secs = Math.min(MAX_REC_SECS, Math.floor((Date.now() - R.started) / 1000));
    var el = $('#rec-time'); if (el) el.textContent = fmtSecs(R.secs);
    if (R.secs >= MAX_REC_SECS && rec.state !== 'inactive') rec.stop();
  }, 250);
  C.rec = R;
  rec.start();
  repaintFoot();
}
function recStop() { var R = S.chat.rec; if (R && R.mode === 'recording' && R.recorder.state !== 'inactive') R.recorder.stop(); }
function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result)); };
    fr.onerror = function () { reject(new Error('Не удалось прочитать файл')); };
    fr.readAsDataURL(blob);
  });
}
async function postChatFile(kind, blob, extra) {
  var C = S.chat, id = C.openId;
  var d = await api('POST', '/api/chats/' + id + '/' + kind, Object.assign({ data: await blobToDataUrl(blob), mime: blob.type }, extra || {}));
  if (C.openId === id) {
    if (C.thread && d.message) { C.thread.messages.push(d.message); C.sig = ''; }
    chatsPaintMessages(); chatsLoadList();
  }
  return d;
}
async function recSend() {
  var C = S.chat, R = C.rec;
  if (!R || R.mode !== 'preview' || R.sending) return;
  if (R.blob.size > MAX_FILE_BYTES) { toast('Запись больше 1,5 МБ — запишите покороче', 'err'); return; }
  R.sending = true; repaintFoot();
  try {
    var d = await postChatFile('voice', R.blob, R.wave ? { seconds: R.wave.seconds, waveform: window.Wave.toBase64(R.wave.waveform) } : null);
    recRelease(R); C.rec = null; repaintFoot();
    if (d.warning) showChatErr(d.warning);
  } catch (e) {
    R.sending = false; repaintFoot(); showChatErr(e.message);
  }
}
// Photos above 1.5 MB are scaled down in a canvas (JPEG) until they fit.
function shrinkImage(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
    img.onload = function () {
      URL.revokeObjectURL(url);
      var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), q = 0.85;
      (function attempt() {
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * scale)); cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) {
          if (!b) { reject(new Error('Не удалось уменьшить фото')); return; }
          if (b.size <= MAX_FILE_BYTES * 0.93) { resolve(b); return; }
          if (q > 0.55) q -= 0.1; else scale *= 0.8;
          if (scale < 0.15) { reject(new Error('Фото слишком большое')); return; }
          attempt();
        }, 'image/jpeg', q);
      })();
    };
    img.src = url;
  });
}
async function chatSendImage(file) {
  var C = S.chat;
  if (C.openId == null || C.sending) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Фото: только JPEG, PNG или WebP', 'err'); return; }
  C.sending = true; showChatErr('');
  try {
    var blob = file.size > MAX_FILE_BYTES * 0.93 ? await shrinkImage(file) : file;
    var caption = C.draft.trim();
    var d = await postChatFile('image', blob, { caption: caption });
    C.draft = ''; var ta = $('#chat-reply'); if (ta) ta.value = '';
    if (d.warning) showChatErr(d.warning);
  } catch (e) { showChatErr(e.message); }
  C.sending = false;
}
async function chatSetSource(value) {
  var C = S.chat, id = C.openId;
  if (id == null) return;
  var traffic = value.split(':')[0], code = value.indexOf(':') >= 0 ? value.slice(value.indexOf(':') + 1) : '';
  var ok = await run('Источник сохранён', function () { return api('POST', '/api/chats/' + id + '/source', { traffic: traffic, code: code }); });
  if (ok) { await chatsRefreshThread(); chatsLoadList(); if (S.data.orders.length) load('orders'); }
  else chatsPaintMessages();
}
async function chatMakeOrder() {
  var id = S.chat.openId;
  if (id == null) return;
  try {
    var d = await api('POST', '/api/chats/' + id + '/order', {});
    toast(d.existing ? 'Заказ уже оформлен' : 'Заказ № ' + d.num + ' создан', 'ok');
    await Promise.all([load('orders'), chatsRefreshThread()]);
    chatsPaintMessages();
    openCard(d.id);
  } catch (e) { toast('Не получилось: ' + e.message, 'err'); }
}
async function chatOpenOrder(orderId) {
  if (!S.data.orders.some(function (o) { return o.id === String(orderId); })) await load('orders');
  openCard(String(orderId));
}
function chatsPoll() {
  if (!S.auth || S.tab !== 'chats' || document.visibilityState !== 'visible' || !S.chat) return;
  chatsLoadList();
  if (S.chat.openId != null) chatsRefreshThread();
}

/* ---------- Settings: «Подключение WhatsApp» (QR connector: Windows laptop or Linux server) ---------- */
var SRV_STATE_TEXT = {
  open: 'WhatsApp подключён', qr: 'ждёт сканирования QR-кода', connecting: 'подключается к WhatsApp…', closed: 'связь с WhatsApp прервалась, пробует снова',
  logged_out: 'номер отвязан, ждёт новый QR-код', banned: 'WhatsApp не пускает этот номер (возможно, он заблокирован)', relinking: 'переподключение…',
  replaced: 'Программа запущена дважды — перезагрузите ноутбук'
};
function serverStatusHTML(sv) {
  if (!sv || !sv.installed) return '<b class="neg">Не установлен</b> <small>Выберите, где будет работать подключение, и следуйте подсказке ниже.</small>';
  if (!sv.lastSeenAt) return '<b class="neg">Не установлен</b> <small>Ключ создан, ждём первый запуск программы.</small>';
  var line = sv.online ? '<b class="pos">На связи</b>' : '<b class="neg">Нет связи ' + (sv.minutesAgo != null ? sv.minutesAgo + ' мин' : '') + '</b>';
  var det = [];
  if (sv.state && sv.online) det.push(SRV_STATE_TEXT[sv.state] || sv.state);
  if (sv.phone) det.push('номер +' + sv.phone + (sv.name ? ' (' + sv.name + ')' : ''));
  if (sv.version) det.push('версия ' + sv.version);
  return line + (det.length ? ' <small>' + esc(det.join(' · ')) + '</small>' : '');
}
// Numbers for one screenshot instead of logs: what the CRM holds and what the connector last complained about.
function diagHTML(sv, d) {
  if (!d) return '';
  var rows = [
    ['Чатов всего', d.contacts], ['С номером телефона', d.withPhone], ['Номер скрыт (только lid)', d.lidOnly], ['Сообщений всего', d.messages],
    ['Сохранено связок lid → номер', d.aliases], ['Запросов старых сообщений в ожидании', d.historyPending], ['Чатов, где старое загружено до конца', d.historyDone],
    ['Запросов старых сообщений с ошибкой', d.historyFailed]
  ];
  var h = '<div class="ws-opt"><div class="ws-opt-h">Диагностика</div><table class="diag"><tbody>' +
    rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td><b>' + esc(r[1] == null ? '—' : r[1]) + '</b></td></tr>'; }).join('') + '</tbody></table>' +
    '<div class="muted fs14">Последняя ошибка программы при обмене с CRM: ' +
    (sv && sv.lastError ? '<b class="neg">' + esc(sv.lastError) + '</b>' + (sv.lastErrorAt ? ' <small>(' + esc(fmtDate(sv.lastErrorAt)) + ')</small>' : '') : '<b class="pos">нет</b>') + '</div></div>';
  return h;
}
function waServerInner() {
  var sv = S.data.server;
  var h = '<div class="ws-status" id="ws-status">' + (sv ? serverStatusHTML(sv) : 'Загружаем…') + '</div>';
  if (sv && sv.relinkPending && !sv.qr) h += '<div class="notice">Идёт переподключение: программа отвязывает старый номер и покажет QR-код (обычно до минуты).</div>';
  if (sv && sv.qr) {
    h += '<div class="qrbox"><img src="' + esc(sv.qr) + '" width="320" height="320" alt="QR-код для привязки WhatsApp">' +
      '<div class="qrhint"><b>Отсканируйте QR-код телефоном</b><br>WhatsApp Business → ⋮ → Связанные устройства → Привязать устройство.<br>' +
      '<small>Код обновляется сам, страницу перезагружать не нужно.</small></div></div>';
  }
  // Option 1: this Windows computer
  h += '<div class="ws-opt"><div class="ws-opt-h">На этом компьютере (Windows)</div>' +
    '<div class="muted fs14">Подойдёт, если сервера нет: подключение работает на вашем ноутбуке. Права администратора не нужны, ставится только для вашего пользователя Windows.</div>' +
    '<ol class="ws-steps"><li>Нажмите кнопку и сохраните файл <b>BikasWhatsApp-setup.cmd</b> (браузер может спросить, оставить ли файл: выберите «Сохранить» или «Оставить»).</li>' +
    '<li>Откройте файл двойным щелчком. Если Windows покажет «Windows защитила ваш компьютер», нажмите «Подробнее» → «Выполнить в любом случае».</li>' +
    '<li>Подождите 2–5 минут, пока в чёрном окне не появится «Готово». Потом здесь появится QR-код.</li></ol>' +
    '<div class="muted fs14">Что произойдёт: установщик скачает нужные программы в папку %LOCALAPPDATA%\\BikasWhatsApp, настроит автозапуск при входе в Windows и запустит подключение. ' +
    '<b>Ноутбук должен быть включён и в интернете, иначе сообщения не дойдут до CRM:</b> ночью, пока он выключен, WhatsApp хранит сообщения и отдаёт их при следующем включении. ' +
    'Файл содержит секретный ключ: никому его не отправляйте. Повторный запуск файла обновляет и чинит установку, сохранённый вход в WhatsApp не удаляется.</div>' +
    (S.winDownloaded && !(sv && sv.online) ? '<div class="notice"><b>Файл скачан.</b> Откройте его из папки «Загрузки» двойным щелчком. Когда установщик напишет «Готово», здесь появится QR-код.</div>' : '') +
    '<div class="row-flex"><button type="button" class="btn' + (sv && sv.installed ? '' : ' pri') + '" data-act="ws-win">Скачать установщик для Windows</button></div></div>';
  // Option 2: Linux server
  h += '<div class="ws-opt"><div class="ws-opt-h">На сервере (Linux)</div>' +
    '<div class="muted fs14">Для небольшого бесплатного сервера, который работает круглосуточно (Google Cloud, Oracle).</div>';
  if (S.serverScript) {
    h += '<div class="notice"><b>Скрипт показан один раз.</b> Он содержит секретный ключ: никому его не отправляйте. Если потеряли, создайте новый ключ (старый перестанет работать).</div>' +
      '<div class="fld"><label for="ws-script">Скрипт для сервера</label><textarea id="ws-script" class="ws-script" readonly spellcheck="false">' + esc(S.serverScript) + '</textarea>' +
      '<small>Вставьте скрипт в настройки сервера. Google Cloud: Compute Engine → ваша машина → Изменить → «Автоматизация» → «Скрипт запуска» (Startup script). Oracle Cloud: Create instance → Show advanced options → Management → Initialization script. Скрипт безопасно запускается при каждой загрузке сервера. Установка занимает несколько минут, потом здесь появится QR-код.</small></div>' +
      '<div class="row-flex"><button type="button" class="btn pri" data-act="ws-copy">Скопировать скрипт</button><button type="button" class="btn" data-act="ws-hide">Скрыть скрипт</button></div>';
  }
  h += '<div class="row-flex"><button type="button" class="btn" data-act="ws-key">Создать ключ подключения</button></div></div>';
  h += '<div class="ws-opt"><div class="ws-opt-h">Старые чаты из телефона</div>' +
    '<div class="muted fs14">WhatsApp отдаёт список старых чатов только один раз, в момент привязки (как при входе в WhatsApp Web). Если они не появились, нажмите кнопку: программа заново привяжется к <b>тому же</b> телефону, покажет новый QR-код, а после сканирования загрузит старые чаты. Номер для ссылок /wa не меняется.</div>' +
    '<div class="row-flex"><button type="button" class="btn" data-act="ws-reload"' + (sv && sv.installed ? '' : ' disabled') + '>Загрузить старые чаты заново</button></div></div>';
  h += diagHTML(sv, S.data.diag);
  h += '<div class="row-flex"><button type="button" class="btn dng" data-act="ws-relink"' + (sv && sv.installed ? '' : ' disabled') + '>Переподключить на другой номер</button></div>';
  return h;
}
function waServerHTML() {
  if (!S.admin) return '';
  return '<div class="h1">Подключение WhatsApp</div><div class="card col14"><div class="muted fs14">Программа-подключение держит один номер WhatsApp (как «Связанное устройство», по QR-коду, как WhatsApp Web) и передаёт сообщения в CRM. Выберите, где она будет работать. ' +
    'Номер заблокировали? Нажмите «Переподключить на другой номер» и отсканируйте QR-код другим телефоном: все ссылки /wa переключатся на новый номер.</div>' +
    '<div class="col14" id="ws-box">' + waServerInner() + '</div></div>';
}
function paintServer() { var el = $('#ws-box'); if (el) el.innerHTML = waServerInner(); }
async function serverRefresh() {
  if (!S.auth || !S.admin) return;
  try { var d = await api('GET', '/api/wa-server'); S.data.server = d.server; S.data.diag = d.diag || null; S.loaded.server = true; paintServer(); } catch (e) { /* the next tick retries */ }
}
function serverFast() {
  var sv = S.data.server;
  return !!sv && sv.installed && (sv.relinkPending || ['qr', 'logged_out', 'connecting', 'closed', 'replaced'].indexOf(sv.state) >= 0 || !sv.lastSeenAt);
}

/* ---------- Inbox: settings sections (admin) ---------- */
function copyBtn(text, label) {
  return '<button type="button" class="icon-btn" data-act="copy-text" data-text="' + esc(text) + '">' + COPY_SVG + (label || 'Копировать') + '</button>';
}
var CONN_LABELS = { qr: 'по QR', cloud: 'Cloud API', '': 'не подключён' };
function agoText(iso) {
  var t = Date.parse(iso || '');
  if (!t) return 'ещё не было сообщений';
  var m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'последнее сообщение только что';
  if (m < 60) return 'последнее сообщение ' + m + ' мин назад';
  if (m < 1440) return 'последнее сообщение ' + Math.round(m / 60) + ' ч назад';
  return 'последнее сообщение ' + Math.round(m / 1440) + ' дн назад';
}
var NUM_STATUS_LABELS = [['active', 'активен'], ['blocked', 'заблокирован'], ['off', 'выключен']];
function waNumbersHTML() {
  var nums = S.data.numbers || [], origin = location.origin;
  var cur = nums.filter(function (n) { return n.isCurrent; })[0];
  var warn = !cur ? '<div class="notice">Сейчас ни один номер не выбран для ссылок: страница /wa показывает «Номер временно недоступен». Выберите номер в колонке «Ссылки ведут сюда».</div>'
    : cur.status !== 'active' ? '<div class="notice">Ссылки сейчас ведут на номер «' + esc(cur.label || cur.phone) + '», а он не активен. Выберите другой номер в колонке «Ссылки ведут сюда».</div>' : '';
  var rows = nums.map(function (n) {
    var id = esc(n.id);
    return '<tr class="' + (n.status === 'active' ? '' : 'off') + '"><td data-l="Номер"><b>+' + esc(n.phone) + '</b></td>' +
      '<td data-l="Подпись"><input type="text" data-wan="' + id + '" data-k="label" value="' + esc(n.label) + '" aria-label="Подпись номера +' + esc(n.phone) + '" maxlength="60"></td>' +
      '<td data-l="Статус"><select data-wan="' + id + '" data-k="status" aria-label="Статус номера +' + esc(n.phone) + '">' + NUM_STATUS_LABELS.map(function (s) {
        return '<option value="' + s[0] + '"' + (n.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select></td>' +
      '<td data-l="Подключение"><b>' + esc(CONN_LABELS[n.connection] || CONN_LABELS['']) + '</b><div><small>' + esc(agoText(n.lastSeenAt)) + '</small></div>' +
        (n.connection === 'cloud' ? '<details class="adv"><summary>Дополнительно</summary><label class="sr" for="pnid-' + id + '">Phone Number ID</label><input id="pnid-' + id + '" type="text" data-wan="' + id + '" data-k="phoneNumberId" value="' + esc(n.phoneNumberId) + '" placeholder="Phone Number ID" aria-label="Phone Number ID" maxlength="40"></details>' : '') + '</td>' +
      '<td class="ctr" data-l="Ссылки ведут сюда"><input type="radio" name="wa-cur" data-wan-cur="' + id + '"' + (n.isCurrent ? ' checked' : '') + (n.status !== 'active' ? ' disabled' : '') + ' aria-label="Ссылки ведут на +' + esc(n.phone) + '"></td>' +
      '<td>' + (n.isCurrent ? '' : '<button type="button" class="btn sm dng" data-act="wan-del" data-id="' + id + '">Удалить</button>') + '</td></tr>';
  }).join('');
  return '<div class="h1">Номера WhatsApp</div><div class="card col14">' +
    '<div class="muted fs14">' + esc(WA_HINT_BLOCK) + '</div>' + warn +
    '<div class="row-flex"><span class="fw6">Общая ссылка для рекламы и лендинга:</span> <code class="wrap-any">' + esc(origin) + '/wa</code>' + copyBtn(origin + '/wa') + '</div>' +
    '<div class="scroll"><table class="t stack"><thead><tr><th>Номер</th><th>Подпись</th><th>Статус</th><th>Подключение</th><th>Ссылки ведут сюда</th><th></th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="6" class="muted">Номеров пока нет. Добавьте первый ниже.</td></tr>') + '</tbody></table></div>' +
    '<div class="fw6">Добавить номер</div><div class="two">' +
    '<div class="fld"><label for="wn-phone">Номер (с кодом страны)</label><input id="wn-phone" type="text" inputmode="tel" autocomplete="off" placeholder="77011234567"></div>' +
    '<div class="fld"><label for="wn-label">Подпись</label><input id="wn-label" type="text" autocomplete="off" placeholder="Основной / Запасной" maxlength="60"></div>' +
    '</div><details class="adv"><summary>Дополнительно</summary><div class="fld"><label for="wn-pnid">Phone Number ID (только для Cloud API, необязательно)</label><input id="wn-pnid" type="text" autocomplete="off" maxlength="40"></div></details>' +
    '<div><button type="button" class="btn pri" data-act="wan-add">Добавить номер</button></div>' +
    (S.waConnected ? '' : '<small>Номера подключаются отдельно (по QR через коннектор или через Cloud API): номера можно добавить заранее, ссылки /wa уже работают.</small>') + '</div>';
}
function targetsHTML() {
  var list = S.data.targets || [], origin = location.origin;
  var rows = list.map(function (tg) {
    var id = esc(tg.id), link = origin + '/wa/' + tg.code;
    return '<tr class="' + (tg.active ? '' : 'off') + '">' +
      '<td data-l="Товар"><input type="text" data-tg="' + id + '" data-k="productName" value="' + esc(tg.productName) + '" aria-label="Товар" maxlength="200"></td>' +
      '<td data-l="Код"><input type="text" class="codein" data-tg="' + id + '" data-k="code" value="' + esc(tg.code) + '" aria-label="Код" maxlength="12"></td>' +
      '<td data-l="Текст сообщения"><textarea class="ta90 tgtext" data-tg="' + id + '" data-k="text" aria-label="Текст сообщения" maxlength="1000">' + esc(tg.text) + '</textarea></td>' +
      '<td class="ctr" data-l="Активен"><input type="checkbox" data-tg-active="' + id + '"' + (tg.active ? ' checked' : '') + ' aria-label="Активен"></td>' +
      '<td class="ctr" data-l="Клики">' + esc(tg.clicks) + '</td><td class="ctr" data-l="Обращения">' + esc(tg.contacts) + '</td>' +
      '<td data-l="Ссылка"><div class="wrap-any"><small>' + esc(link) + '</small></div>' + copyBtn(link) + '</td>' +
      '<td><button type="button" class="btn sm dng" data-act="tg-del" data-id="' + id + '">Удалить</button></td></tr>';
  }).join('');
  return '<div class="h1">Таргет — товары и тексты</div><div class="card col14">' +
    '<div class="muted fs14">Этот текст клиент отправит сам из рекламы или лендинга. CRM по нему поймёт, что клиент из таргета и по какому товару.</div>' +
    '<div class="scroll"><table class="t tgt stack"><thead><tr><th>Товар</th><th>Код</th><th>Текст сообщения</th><th>Активен</th><th>Клики</th><th>Обращения</th><th>Ссылка</th><th></th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="8" class="muted">Текстов пока нет. Добавьте первый ниже.</td></tr>') + '</tbody></table></div>' +
    '<div class="fw6">Добавить товар</div><div class="two">' +
    '<div class="fld"><label for="tn-product">Товар</label><input id="tn-product" type="text" autocomplete="off" maxlength="200"></div>' +
    '<div class="fld"><label for="tn-code">Код (например A3)</label><input id="tn-code" type="text" autocomplete="off" maxlength="12"></div></div>' +
    '<div class="fld"><label for="tn-text">Текст сообщения</label><textarea id="tn-text" class="ta90" maxlength="1000" placeholder="Здравствуйте! Хочу заказать отпариватель, подскажите цену и доставку (A3)"></textarea>' +
    '<small>Код в скобках в конце текста помогает CRM узнать клиента точнее: клиент может поменять слова, но код обычно остаётся.</small></div>' +
    '<div><button type="button" class="btn pri" data-act="tg-add">Добавить</button></div></div>';
}

/* ---------- data loading ---------- */
var LOADERS = {
  orders: ['GET', '/api/orders', function (d) { S.data.orders = d.orders || []; }],
  products: ['GET', '/api/products', function (d) { S.data.products = d.products || []; }],
  content: ['GET', '/api/content', function (d) { S.data.content = d.content || []; }],
  settings: ['GET', '/api/settings', function (d) { S.data.settings = d.settings || null; }],
  finance: ['GET', '/api/finance', function (d) { S.data.finance = d.finance || {}; }],
  users: ['GET', '/api/users', function (d) { S.data.users = d.users || []; }],
  bot: ['GET', '/api/bot', function (d) { S.data.bot = d.bot || null; }],
  numbers: ['GET', '/api/wa-numbers', function (d) { S.data.numbers = d.numbers || []; }],
  targets: ['GET', '/api/targets', function (d) { S.data.targets = d.targets || []; }],
  server: ['GET', '/api/wa-server', function (d) { S.data.server = d.server || null; S.data.diag = d.diag || null; }]
};
async function load(key) {
  var l = LOADERS[key];
  try {
    var d = await api(l[0], l[1]);
    l[2](d);
    delete S.errors[key];
  } catch (e) {
    if (e.status === 401) return;
    S.errors[key] = e.message;
  }
  S.loaded[key] = true;
  scheduleRender();
}
function allKeys() { return S.admin ? ['orders', 'products', 'content', 'settings', 'finance', 'users', 'bot', 'numbers', 'targets', 'server'] : ['orders', 'products', 'content', 'settings']; }
async function loadAll() { await Promise.all(allKeys().map(load)); }
// Light periodic refresh: only what the open tab shows.
function pollKeys() {
  var t = S.tab;
  if (t === 'content') return ['content'];
  if (t === 'managers') return ['users'];
  if (t === 'bot') return ['bot'];
  if (t === 'settings') return S.admin ? ['numbers', 'targets', 'server'] : ['numbers', 'targets'];
  if (t === 'account' || t === 'chats') return [];
  return ['orders', 'products'];
}
async function poll() {
  if (!S.auth || document.visibilityState !== 'visible' || S.card) return;
  await Promise.all(pollKeys().map(load));
  if (S.tab !== 'chats') chatsCount();
}

/* ---------- auth ---------- */
function applyMe(me) {
  S.user = me.user; S.admin = me.user.role === 'admin'; S.canDispatch = !!me.canDispatch;
  S.publishUrl = me.publishUrl || PUBLISH_URL; S.auth = true; S.waConnected = !!me.waConnected; S.chat = freshChat();
}
function goLogin() {
  if (!S.auth && S.booted) return; // already on the login screen
  resetSession();
}
function resetSession() {
  S.auth = false; S.user = null; S.admin = false; S.loaded = {}; S.errors = {}; S.card = null; S.drawer = false; S.kz = null;
  S.data = { orders: [], products: [], finance: {}, content: [], users: [], settings: null, bot: null, numbers: [], targets: [] };
  S.chat = freshChat();
  $('#card-root').innerHTML = '';
  renderAll();
}
async function doLogin(form) {
  var lg = form.querySelector('#l-login').value, pw = form.querySelector('#l-pass').value;
  var btn = form.querySelector('#l-submit'); btn.disabled = true;
  try {
    await api('POST', '/api/login', { email: lg, password: pw });
    var me = await api('GET', '/api/me');
    S.loginError = '';
    applyMe(me);
    S.tab = 'orders'; S.loaded = {};
    renderAll();
    loadAll();
    chatsCount();
  } catch (e) {
    S.loginError = e.message;
    S.auth = false;
    doRender(true);
    var l = document.getElementById('l-login'); if (l) l.value = lg;
  }
}
async function doLogout() {
  try { await api('POST', '/api/logout', {}); } catch (e) { /* the session is gone either way */ }
  resetSession();
}

/* ---------- other actions ---------- */
function numField(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function textField(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
function rawField(id) { var e = document.getElementById(id); return e ? e.value : ''; }

async function doPublish(date, time) {
  var what = date && time ? 'слот ' + dayLabel(date) + ' ' + time : 'все слоты, чему пришло время';
  if (!window.confirm('Опубликовать сейчас: ' + what + '?')) return;
  try {
    await api('POST', '/api/publish', { date: date || '', time: time || '' });
    toast('Запуск отправлен в GitHub. Пост выйдет через 1–2 минуты, потом обновится статус.', 'ok');
  } catch (e) {
    if (e.data && e.data.url) {
      toast(e.message, 'err');
      window.open(e.data.url, '_blank', 'noopener');
    } else toast('Не запустилось: ' + e.message, 'err');
  }
}

var ACTIONS = {
  'tab': function (t) { recCancel(true); S.tab = t.dataset.tab; S.drawer = false; S.resetFor = null; if (S.tab === 'chats' && S.chat) S.chat.loaded = false; renderDrawer(); renderHeader(); doRender(true); window.scrollTo(0, 0); poll(); },
  'drawer': function () { S.drawer = !S.drawer; renderDrawer(); },
  'drawer-close': function () { S.drawer = false; renderDrawer(); },
  'logout': function () { doLogout(); },
  'filter': function (t) { var f = t.dataset.f; S.filter = (f === 'remind' && S.filter === 'remind') ? 'all' : f; doRender(true); },
  'period': function (t) { S.period = t.dataset.p; doRender(true); },
  'content-day': function (t) { S.contentDay = t.dataset.d; doRender(true); },
  'publish': function (t) { doPublish(t.dataset.date, t.dataset.time); },
  'open-order': function (t) { openCard(t.dataset.id); },
  'new-order': function () { openCard(null); },
  'kz-open': function () { var f = document.getElementById('kz-file'); if (f) f.click(); },
  'kz-close': function () { S.kz = null; doRender(true); },
  'kz-apply': function () { kzApply(); },
  'send-track': function (t) { sendTrack(t.dataset.id); },
  'close-card': function () { closeCard(); },
  'card-save': function () { saveCard(); },
  'card-del': function () { showDelConfirm(); },
  'card-del-no': function () { $('#del-area').innerHTML = ''; },
  'card-del-yes': function () { deleteCard(); },
  'copy-phone': function () { copyText(textField('f-phone'), 'Номер скопирован', 'f-phone'); },
  'copy-pay': function () { copyText(S.data.settings && S.data.settings.payLink, 'Ссылка на оплату скопирована'); },
  'copy-setting': function (t) { copyText(S.data.settings && S.data.settings[t.dataset.k], 'Скопировано'); },
  'prod-add': async function () {
    var name = textField('p-name');
    if (!name) { toast('Не сохранилось: введите название товара', 'err'); return; }
    var price = Math.max(0, num(numField('p-price'))), stock = Math.max(0, Math.round(num(numField('p-stock'))));
    var ok = await run('Товар добавлен', function () { return api('POST', '/api/products', { name: name, price: price, stock: stock }); });
    if (ok) { await load('products'); doRender(true); }
  },
  'user-add': async function () {
    var data = { email: textField('u-login').toLowerCase(), name: textField('u-name'), password: rawField('u-pass') };
    var ok = await run('Менеджер создан', function () { return api('POST', '/api/users', data); });
    if (ok) { await load('users'); doRender(true); }
  },
  'user-toggle': async function (t) {
    var on = t.dataset.on === '1';
    var ok = await run(on ? 'Доступ включён' : 'Менеджер отключён', function () { return api('PATCH', '/api/users/' + t.dataset.id, { active: on }); });
    if (ok) { await load('users'); doRender(true); }
  },
  'user-reset': function (t) { S.resetFor = parseInt(t.dataset.id, 10); doRender(true); var e = document.getElementById('rp-' + t.dataset.id); if (e) e.focus(); },
  'user-reset-no': function () { S.resetFor = null; doRender(true); },
  'user-reset-save': async function (t) {
    var pw = rawField('rp-' + t.dataset.id);
    var ok = await run('Пароль сброшен, менеджеру нужно войти заново', function () { return api('POST', '/api/users/' + t.dataset.id + '/password', { password: pw }); });
    if (ok) { S.resetFor = null; doRender(true); }
  },
  'email-save': async function () {
    var em = textField('em-new').toLowerCase(), pw = rawField('em-pass');
    var ok = await run('Почта изменена', function () { return api('POST', '/api/me/email', { email: em, password: pw }); });
    if (ok) { S.user.email = em; renderHeader(); doRender(true); }
  },
  'pw-save': async function () {
    var cur = rawField('pw-cur'), p1 = rawField('pw-new'), p2 = rawField('pw-new2');
    if (p1 !== p2) { toast('Не сохранилось: новые пароли не совпадают', 'err'); return; }
    var ok = await run('Пароль изменён', function () { return api('POST', '/api/me/password', { current: cur, password: p1 }); });
    if (ok) doRender(true);
  },
  'copy-text': function (t) { copyText(t.dataset.text, 'Скопировано'); },
  'chat-open': function (t) { chatOpen(parseInt(t.dataset.id, 10)); },
  'chat-back': function () { chatBack(); },
  'chat-filter': function (t) { S.chat.filter = t.dataset.f; S.chat.loaded = false; doRender(true); chatsLoadList(); },
  'chat-send': function () { chatSend(); },
  'rec-start': function () { recStart(); },
  'rec-stop': function () { recStop(); },
  'rec-cancel': function () { recCancel(); },
  'rec-send': function () { recSend(); },
  'chat-attach': function () { var f = document.getElementById('chat-img'); if (f) f.click(); },
  'ws-key': async function () {
    var sv = S.data.server;
    if (sv && sv.installed && !window.confirm('Создать новый ключ? Старый ключ сразу перестанет работать: сервер придётся установить заново (или обновить в нём ключ). Продолжить?')) return;
    try {
      var d = await api('POST', '/api/wa-server/key', {});
      S.serverScript = d.script || '';
      await serverRefresh();
      toast('Ключ создан. Скрипт показан один раз — скопируйте его.', 'ok');
      var el = document.getElementById('ws-script'); if (el) el.scrollIntoView({ block: 'center' });
    } catch (e) { toast('Не получилось: ' + e.message, 'err'); }
  },
  'ws-win': async function () {
    var sv = S.data.server;
    if (sv && sv.installed && !window.confirm('Создать новый ключ и скачать установщик? Старый ключ сразу перестанет работать: уже установленное подключение (на другом компьютере или сервере) придётся поставить заново новым файлом. Продолжить?')) return;
    try {
      var res;
      try { res = await fetch('/api/wa-server/windows-installer', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      catch (e) { throw new Error('нет связи с сервером'); }
      if (res.status === 401) { goLogin(); return; }
      if (!res.ok) { var er = null; try { er = await res.json(); } catch (x) { er = null; } throw new Error((er && er.error) || ('ошибка ' + res.status)); }
      var blob = new Blob([await res.blob()], { type: 'application/octet-stream' });
      var a = document.createElement('a'), u = URL.createObjectURL(blob);
      a.href = u; a.download = 'BikasWhatsApp-setup.cmd'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
      S.winDownloaded = true; S.serverScript = '';
      await serverRefresh(); paintServer();
      toast('Установщик скачан. Откройте его двойным щелчком.', 'ok');
    } catch (e) { toast('Не получилось: ' + e.message, 'err'); }
  },
  'ws-copy': function () { copyText(S.serverScript, 'Скрипт скопирован', 'ws-script'); },
  'ws-hide': function () { S.serverScript = ''; paintServer(); },
  'ws-reload': async function () {
    if (!window.confirm('Загрузить старые чаты заново?\n\nПрограмма отвяжется от WhatsApp и покажет новый QR-код. Отсканируйте его ТЕМ ЖЕ телефоном (WhatsApp Business → Связанные устройства → Привязать устройство). Старые чаты загрузятся за несколько минут, сообщения и ссылки /wa останутся как есть. Пока идёт переподключение (1–2 минуты), новые сообщения придут чуть позже.')) return;
    try {
      await api('POST', '/api/wa-server/reload-history', {});
      toast('Команда отправлена. Через минуту здесь появится QR-код.', 'ok');
      await serverRefresh();
    } catch (e) { toast('Не получилось: ' + e.message, 'err'); }
  },
  'ws-relink': async function () {
    if (!window.confirm('Переподключить на другой номер?\n\nТекущий номер будет отвязан от сервера, появится QR-код. После сканирования другим телефоном все ссылки /wa и /wa/<код> переключатся на новый номер.')) return;
    try {
      await api('POST', '/api/wa-server/relink', {});
      toast('Команда отправлена. Через минуту здесь появится QR-код.', 'ok');
      await serverRefresh();
    } catch (e) { toast('Не получилось: ' + e.message, 'err'); }
  },
  'chat-older': function () { chatOlder(); },
  'chat-order': function () { chatMakeOrder(); },
  'chat-order-open': function (t) { chatOpenOrder(t.dataset.id); },
  'wan-add': async function () {
    var data = { phone: textField('wn-phone'), label: textField('wn-label'), phoneNumberId: textField('wn-pnid') };
    var ok = await run('Номер добавлен', function () { return api('POST', '/api/wa-numbers', data); });
    if (ok) { await load('numbers'); doRender(true); }
  },
  'wan-del': async function (t) {
    if (!window.confirm('Удалить этот номер из списка?')) return;
    var ok = await run('Номер удалён', function () { return api('DELETE', '/api/wa-numbers/' + t.dataset.id); });
    if (ok) { await load('numbers'); doRender(true); }
  },
  'tg-add': async function () {
    var data = { productName: textField('tn-product'), code: textField('tn-code'), text: textField('tn-text'), active: true };
    var ok = await run('Текст добавлен', function () { return api('POST', '/api/targets', data); });
    if (ok) { await load('targets'); doRender(true); }
  },
  'tg-del': async function (t) {
    if (!window.confirm('Удалить этот текст? Ссылка с его кодом перестанет подставлять текст.')) return;
    var ok = await run('Удалено', function () { return api('DELETE', '/api/targets/' + t.dataset.id); });
    if (ok) { await load('targets'); doRender(true); }
  },
  'set-save': async function () {
    var data = { wa1: textField('set-wa1'), wa2: textField('set-wa2'), payLink: textField('set-payLink'), templates: rawField('set-templates'), track_msg: rawField('set-track_msg'), track_url: textField('set-track_url') };
    if (data.track_url && !(/^https:\/\//i.test(data.track_url) && data.track_url.indexOf('{трек}') >= 0)) {
      toast('Не сохранилось: ссылка для отслеживания должна начинаться с https:// и содержать {трек}', 'err'); return;
    }
    var ok = await run('Настройки сохранены', function () { return api('PUT', '/api/settings', data); });
    if (ok) await load('settings');
  }
};

async function saveFin(pid) {
  var ks = ['buy', 'ship', 'pack', 'feePct', 'other'], obj = {};
  ks.forEach(function (k) { obj[k] = Math.max(0, num(numField('fin-' + pid + '-' + k))); });
  var ok = await run('Сохранено', function () { return api('PUT', '/api/finance/' + encodeURIComponent(pid), obj); });
  if (ok) { await load('finance'); }
}

/* ---------- event wiring ---------- */
document.addEventListener('click', function (e) {
  if (e.target.closest && e.target.closest('select, a')) return; // status selects and links inside table rows must not open the card
  var t = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!t) return;
  var h = ACTIONS[t.dataset.act];
  if (h) { try { h(t, e); } catch (x) { toast('Ошибка: ' + x.message, 'err'); } }
});
document.addEventListener('submit', function (e) {
  if (e.target && e.target.id === 'login-form') { e.preventDefault(); doLogin(e.target); }
});
document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.id === 'orders-search') { S.q = t.value; doRender(true); }
  else if (t.id === 'chat-search') {
    S.chat.q = t.value; clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(chatsLoadList, 250);
  }
  else if (t.id === 'chat-reply') S.chat.draft = t.value;
  else if (t.id === 'f-qty') autofillSum();
  else if (t.id === 'f-track') syncExtra();
  else if (t.id === 'f-phone') syncWa();
});
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!S.auth) return;
  if (t.id === 'kz-file') { kzLoadFile(t); return; }
  if (t.id === 'chat-src') { chatSetSource(t.value); return; }
  if (t.id === 'chat-img') { var pf = t.files && t.files[0]; t.value = ''; if (pf) chatSendImage(pf); return; }
  if (t.dataset && t.dataset.wan) {
    var wp = {}; wp[t.dataset.k] = t.value.trim();
    run('Сохранено', function () { return api('PATCH', '/api/wa-numbers/' + t.dataset.wan, wp); }).then(function () { return load('numbers'); }).then(function () { doRender(true); });
    if (t.dataset.k === 'status' && t.value !== 'active') {
      var cn = S.data.numbers.filter(function (n) { return String(n.id) === t.dataset.wan; })[0];
      if (cn && cn.isCurrent) toast('Ссылки ещё ведут на этот номер. Выберите другой номер в колонке «Ссылки ведут сюда».', 'err');
    }
    return;
  }
  if (t.dataset && t.dataset.wanCur) {
    run('Ссылки теперь ведут на этот номер', function () { return api('POST', '/api/wa-numbers/' + t.dataset.wanCur + '/current', {}); }).then(function () { return load('numbers'); }).then(function () { doRender(true); });
    return;
  }
  if (t.dataset && t.dataset.tg) {
    var tp = {}; tp[t.dataset.k] = t.value.trim();
    run('Сохранено', function () { return api('PATCH', '/api/targets/' + t.dataset.tg, tp); }).then(function () { return load('targets'); }).then(function () { doRender(true); });
    return;
  }
  if (t.dataset && t.dataset.tgActive) {
    run('Сохранено', function () { return api('PATCH', '/api/targets/' + t.dataset.tgActive, { active: !!t.checked }); }).then(function () { return load('targets'); }).then(function () { doRender(true); });
    return;
  }
  if (t.dataset && t.dataset.kz !== undefined && S.kz && S.kz.items) {
    S.kz.items[parseInt(t.dataset.kz, 10)].orderId = t.value;
    doRender(true);
    return;
  }
  if (t.dataset && t.dataset.ost) { rowStatus(t); return; }
  if (t.id === 'card-st') { cardStatus(t.value); return; }
  if (t.id === 'f-remind' || t.id === 'f-delivery') { syncExtra(); return; }
  if (t.id === 'f-product') { autofillSum(); return; }
  if (t.dataset && t.dataset.fin) { saveFin(t.dataset.fin); return; }
  if (t.id === 'fin-fixed') {
    var v = Math.max(0, num(t.value));
    run('Сохранено', function () { return api('PUT', '/api/finance/general', { fixedMonth: v }); }).then(function (ok) { if (ok) load('finance'); });
    return;
  }
  if (t.dataset && t.dataset.prod) {
    var k = t.dataset.k, val = Math.max(0, num(t.value));
    if (k === 'stock') val = Math.round(val);
    var patch = {}; patch[k] = val;
    run('Сохранено', function () { return api('PATCH', '/api/products/' + t.dataset.prod, patch); }).then(function () { load('products'); });
    return;
  }
  if (t.dataset && t.dataset.prodActive) {
    run('Сохранено', function () { return api('PATCH', '/api/products/' + t.dataset.prodActive, { active: !!t.checked }); }).then(function () { load('products'); });
  }
});
document.addEventListener('focusout', function () {
  if (!S.dirty) return;
  setTimeout(function () { if (S.dirty && !fieldFocused()) doRender(true); }, 250);
});
document.addEventListener('keydown', function (e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('orow')) {
    e.preventDefault();
    openCard(e.target.dataset.id);
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'chat-reply') { e.preventDefault(); chatSend(); return; }
  if (e.key !== 'Escape') return;
  if (S.card) closeCard();
  else if (S.drawer) { S.drawer = false; renderDrawer(); }
});
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); });
setInterval(poll, POLL_MS);
setInterval(chatsPoll, CHAT_POLL_MS);
// While the QR code or a relink is on screen the status refreshes every 3 s (only the «Сервер WhatsApp» block is repainted).
setInterval(function () {
  if (S.auth && S.admin && S.tab === 'settings' && document.visibilityState === 'visible' && serverFast()) serverRefresh();
}, 3000);

/* ---------- boot ---------- */
async function boot() {
  renderAll();
  try {
    var me = await api('GET', '/api/me');
    S.booted = true;
    if (me.user) { applyMe(me); renderAll(); loadAll(); chatsCount(); } else renderAll();
  } catch (e) {
    S.booted = true; S.auth = false;
    if (e.status && e.status !== 401) S.loginError = e.message;
    renderAll();
  }
}
boot();
})();

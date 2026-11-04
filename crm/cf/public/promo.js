/* Bikas CRM: promotions «1+1» / «2+1» and the money math that depends on them. Plain JS, no build step; works in the browser
   (window.Promo) and in Node (module.exports, test/promo.test.js). The Worker has its own giftFor with the same rules (worker.js).
   Order fields: qty = units shipped (paid + gift), paidQty = units paid for, giftQty = units given away, sum = money received. */
(function (root) {
'use strict';

function num(v) {
  var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[\s ]/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
// Gift units: 1+1 gives as many as were paid, 2+1 one per two paid.
function giftFor(promo, paid) {
  paid = Math.max(0, Math.floor(num(paid)));
  if (promo === '1+1') return paid;
  if (promo === '2+1') return Math.floor(paid / 2);
  return 0;
}
// Units of an order as {paid, gift, total}; total is what shipped. Rows without paidQty (old server) count everything as paid.
function orderUnits(o) {
  var total = Math.max(0, Math.round(num(o.qty)));
  var gift = Math.max(0, Math.round(num(o.giftQty)));
  if (gift > total) gift = total;
  var paid = o.paidQty != null && num(o.paidQty) > 0 ? Math.round(num(o.paidQty)) : total - gift;
  return { paid: paid, gift: gift, total: total };
}
// «3 шт. (2 + 1 в подарок)» for a promo order, '' otherwise.
function qtyLabel(o) {
  var u = orderUnits(o);
  return o.promo && u.gift ? u.total + ' шт. (' + u.paid + ' + ' + u.gift + ' в подарок)' : '';
}

/* Cost model of a product (finance/<productId>): buy and other are per UNIT (multiplied by the shipped units, gifts included);
   ship and pack are per PARCEL (one order = one Kazpost parcel, counted once whatever the quantity); feePct is a % of the sum.
   extras = [{name, amount, per: 'unit' | 'parcel'}] are the owner's own cost lines. */
function extrasSum(f, per) {
  var t = 0;
  ((f && f.extras) || []).forEach(function (x) { if (x && x.per === per) t += num(x.amount); });
  return t;
}
function unitCosts(f) {
  f = f || {};
  return { unit: num(f.buy) + num(f.other) + extrasSum(f, 'unit'), parcel: num(f.ship) + num(f.pack) + extrasSum(f, 'parcel'), feePct: num(f.feePct) };
}
// Profit of ONE order of `paid` paid units under `promo`: revenue = price x paid, costs by shipped units + once per parcel + fee.
function orderProfit(price, f, promo, paid) {
  paid = Math.max(1, Math.round(num(paid) || 1));
  var gift = giftFor(promo, paid), c = unitCosts(f), rev = num(price) * paid;
  return { paid: paid, gift: gift, shipped: paid + gift, rev: rev, cost: (paid + gift) * c.unit + c.parcel + rev * c.feePct / 100,
    profit: rev - (paid + gift) * c.unit - c.parcel - rev * c.feePct / 100 };
}

/* Upsell: an order may carry extra product lines o.items = [{productId, productName, qty, sum}] (the main line is o.productId / o.qty / o.sum / o.promo).
   The whole order is ONE parcel: the parcel costs (ship, pack, «на посылку» lines) and the fee % are taken from the MAIN product's finance, once per order;
   every extra line adds its qty x the per-unit costs (buy + other + «на штуку» lines) of ITS OWN product. Revenue is the order total (main sum + extra sums). */
function orderItems(o) { return Array.isArray(o && o.items) ? o.items : []; }
function orderTotal(o) {
  var t = num(o.sum);
  orderItems(o).forEach(function (i) { t += num(i.sum); });
  return t;
}
// Money result of ONE order: {rev, cost, giftCost, itemQty, itemRev, missing[]}; profit = rev - cost. cost is 0 for a product without finance (it is listed in missing).
function orderCalc(o, finance) {
  finance = finance || {};
  var u = orderUnits(o), total = orderTotal(o), cost = 0, giftCost = 0, itemQty = 0, itemRev = 0, missing = [];
  var f = finance[o.productId];
  if (!f) missing.push(o.productName || 'товар не выбран');
  else {
    var c = unitCosts(f);
    cost += u.total * c.unit + c.parcel + total * c.feePct / 100;
    giftCost = u.gift * num(f.buy);
  }
  orderItems(o).forEach(function (i) {
    var q = Math.max(0, Math.round(num(i.qty)));
    itemQty += q; itemRev += num(i.sum);
    var fi = finance[i.productId];
    if (!fi) { var nm = i.productName || 'товар не выбран'; if (missing.indexOf(nm) < 0) missing.push(nm); return; }
    cost += q * unitCosts(fi).unit;
  });
  return { rev: total, cost: cost, giftCost: giftCost, itemQty: itemQty, itemRev: itemRev, missing: missing };
}

/* Profit of a list of orders that count as sold (the caller applies the status/period filters).
   finance = { <productId>: {buy, ship, pack, feePct, other, extras}, general: {fixedMonth} }.
   Per order: shipped units x per-unit costs + per-parcel costs once + fee % of the sum (see orderCalc for upsell lines); revenue is the money received.
   giftCost = purchase price x gift units: informational, it is already inside `cost`. qty / paidQty / giftQty count the main lines only. */
function calcProfit(orders, finance, days) {
  finance = finance || {};
  var shipped = 0, paid = 0, gift = 0, rev = 0, cost = 0, giftCost = 0, itemQty = 0, itemRev = 0, missing = {};
  orders.forEach(function (o) {
    var u = orderUnits(o), r = orderCalc(o, finance);
    shipped += u.total; paid += u.paid; gift += u.gift; rev += r.rev; cost += r.cost; giftCost += r.giftCost; itemQty += r.itemQty; itemRev += r.itemRev;
    r.missing.forEach(function (n) { missing[n] = 1; });
  });
  var fixed = num((finance.general || {}).fixedMonth) * (days == null ? 0 : days) / 30;
  return { qty: shipped, paidQty: paid, giftQty: gift, giftCost: giftCost, itemQty: itemQty, itemRev: itemRev, rev: rev, cost: cost, fixed: fixed, net: rev - cost - fixed, missing: Object.keys(missing) };
}
// Promotion statistics of a list of orders: counts per promo, gift units, shipped vs paid units.
function promoStats(orders) {
  var r = { orders11: 0, orders21: 0, gift: 0, shipped: 0, paid: 0 };
  orders.forEach(function (o) {
    var u = orderUnits(o);
    r.shipped += u.total; r.paid += u.paid; r.gift += u.gift;
    if (o.promo === '1+1') r.orders11++;
    else if (o.promo === '2+1') r.orders21++;
  });
  return r;
}

// Upsell statistics: orders with extra lines, extra units and extra revenue.
function upsellStats(orders) {
  var r = { orders: 0, units: 0, rev: 0 };
  orders.forEach(function (o) {
    var its = orderItems(o);
    if (!its.length) return;
    r.orders++;
    its.forEach(function (i) { r.units += Math.max(0, Math.round(num(i.qty))); r.rev += num(i.sum); });
  });
  return r;
}

/* Advertising economics of a period. The caller filters by period (Almaty): `orders` created in it, `spend` rows dated in it, `leads` whose first message is in it.
     orders  [{status, traffic, isRepeat, productId, productName, sum, qty, items..}]   sold = status paid / sent / done
     spend   [{productId, amountKzt}]                                                   ad_spend rows joined with their campaign's product
     leads   [{code, productName, n}]                                                   target contacts grouped by ad code
     targets [{code, productId, productName}]   products [{id, name}]   finance, days  (as calcProfit)
   Groups: target = traffic 'target' and not repeat (ALL ad spend is charged here), organic = every other traffic and not repeat, repeat = isRepeat.
   Per product (target orders only): leads, CPL = ad / leads, paid target orders, CPO = ad / orders (null when 0), profit = sum of the orders' results, profitAfterAds = profit - ad.
   Order results use the money actually received and the cost model of calcProfit, so groups add up to the profit page. */
var SOLD = { paid: 1, sent: 1, done: 1 };
function economics(o) {
  var finance = o.finance || {}, products = o.products || [], targets = o.targets || [];
  var sold = (o.orders || []).filter(function (x) { return SOLD[x.status]; });
  var ad = {}, adTotal = 0;
  (o.spend || []).forEach(function (r) { var k = r.productId || ''; ad[k] = (ad[k] || 0) + num(r.amountKzt); adTotal += num(r.amountKzt); });
  var norm = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  var prodByName = function (n) { n = norm(n); if (!n) return ''; var p = products.filter(function (x) { return norm(x.name) === n; })[0]; return p ? p.id : ''; };
  var leadsBy = {}, leadsTotal = 0;
  (o.leads || []).forEach(function (l) {
    var t = targets.filter(function (x) { return l.code && norm(x.code) === norm(l.code); })[0], pid = '';
    if (t) pid = t.productId || prodByName(t.productName);
    if (!pid) pid = prodByName(l.productName);
    var n = Math.max(0, Math.round(num(l.n)));
    leadsBy[pid] = (leadsBy[pid] || 0) + n; leadsTotal += n;
  });
  var groups = { target: { orders: 0, rev: 0, cost: 0, profit: 0 }, organic: { orders: 0, rev: 0, cost: 0, profit: 0 }, repeat: { orders: 0, rev: 0, cost: 0, profit: 0 } };
  var rows = {}, missing = {}, rev = 0, cost = 0;
  var rowOf = function (pid) { return rows[pid] || (rows[pid] = { productId: pid, name: '', adSpend: 0, leads: 0, paidOrders: 0, rev: 0, cost: 0, profit: 0 }); };
  sold.forEach(function (x) {
    var r = orderCalc(x, finance), res = r.rev - r.cost;
    r.missing.forEach(function (n) { missing[n] = 1; });
    rev += r.rev; cost += r.cost;
    var g = x.isRepeat ? 'repeat' : x.traffic === 'target' ? 'target' : 'organic';
    groups[g].orders++; groups[g].rev += r.rev; groups[g].cost += r.cost; groups[g].profit += res;
    if (g === 'target') { var pr = rowOf(x.productId || ''); pr.paidOrders++; pr.rev += r.rev; pr.cost += r.cost; pr.profit += res; }
  });
  Object.keys(ad).forEach(function (k) { rowOf(k); });
  Object.keys(leadsBy).forEach(function (k) { rowOf(k); });
  var list = Object.keys(rows).map(function (k) {
    var r = rows[k], p = products.filter(function (x) { return x.id === k; })[0];
    r.name = p ? p.name : (k ? 'Товар удалён' : 'Товар не определён');
    r.adSpend = ad[k] || 0; r.leads = leadsBy[k] || 0;
    r.cpl = r.leads > 0 ? r.adSpend / r.leads : null;
    r.cpo = r.paidOrders > 0 ? r.adSpend / r.paidOrders : null;
    r.profitAfterAds = r.profit - r.adSpend;
    return r;
  }).sort(function (a, b) { return b.adSpend - a.adSpend || String(a.name).localeCompare(String(b.name), 'ru'); });
  groups.target.ads = adTotal;
  groups.target.profitAfterAds = groups.target.profit - adTotal;
  var fixed = num((finance.general || {}).fixedMonth) * (o.days == null ? 0 : o.days) / 30;
  var tOrders = groups.target.orders;
  return {
    adSpend: adTotal, leads: leadsTotal, cpl: leadsTotal > 0 ? adTotal / leadsTotal : null,
    paidTargetOrders: tOrders, cpo: tOrders > 0 ? adTotal / tOrders : null,
    groups: groups, products: list, rev: rev, cost: cost, fixed: fixed, net: rev - cost - adTotal - fixed, missing: Object.keys(missing)
  };
}

var api = { unitCosts: unitCosts, orderProfit: orderProfit, giftFor: giftFor, orderUnits: orderUnits, qtyLabel: qtyLabel, calcProfit: calcProfit, promoStats: promoStats, orderTotal: orderTotal, orderCalc: orderCalc, upsellStats: upsellStats, economics: economics };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Promo = api;
})(typeof window !== 'undefined' ? window : globalThis);

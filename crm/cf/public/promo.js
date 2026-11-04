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

/* Profit of a list of orders that count as sold (the caller applies the status/period filters).
   finance = { <productId>: {buy, ship, pack, feePct, other, extras}, general: {fixedMonth} }.
   Per order: shipped units x per-unit costs + per-parcel costs once + fee % of the sum; revenue is the money received.
   giftCost = purchase price x gift units: informational, it is already inside `cost`. */
function calcProfit(orders, finance, days) {
  finance = finance || {};
  var shipped = 0, paid = 0, gift = 0, rev = 0, cost = 0, giftCost = 0, missing = {};
  orders.forEach(function (o) {
    var u = orderUnits(o), s = num(o.sum);
    shipped += u.total; paid += u.paid; gift += u.gift; rev += s;
    var f = finance[o.productId];
    if (!f) { missing[o.productName || 'товар не выбран'] = 1; return; }
    var c = unitCosts(f);
    cost += u.total * c.unit + c.parcel + s * c.feePct / 100;
    giftCost += u.gift * num(f.buy);
  });
  var fixed = num((finance.general || {}).fixedMonth) * (days == null ? 0 : days) / 30;
  return { qty: shipped, paidQty: paid, giftQty: gift, giftCost: giftCost, rev: rev, cost: cost, fixed: fixed, net: rev - cost - fixed, missing: Object.keys(missing) };
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

var api = { unitCosts: unitCosts, orderProfit: orderProfit, giftFor: giftFor, orderUnits: orderUnits, qtyLabel: qtyLabel, calcProfit: calcProfit, promoStats: promoStats };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Promo = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Bikas CRM: Kazpost registry (PDF) parsing. Plain JS, no build step; works in the browser (window.Kazpost) and in Node (module.exports).
   Pipeline: PDF -> pdf.js text items -> lines (rebuilt by y-coordinate, like `pdftotext -layout`) -> parseKazpost(text) -> parcels.
   Client names, phones and addresses only live in memory of the page; nothing here logs or stores them. */
(function (root) {
'use strict';

var PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
var PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';
var TRACK_RE = /([A-Z]{2}\d{9}[A-Z]{2})/;

/* ---------- text helpers ---------- */
function collapse(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }

// 7XXXXXXXXXX (Kazakhstan). Accepts +7 / 8 prefixes and a bare 10-digit number; anything else gives ''.
function normPhone(raw) {
  var d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && (d.charAt(0) === '8' || d.charAt(0) === '7')) return '7' + d.slice(1);
  if (d.length === 10) return '7' + d;
  return '';
}

// Phone-like token: 10-11 digits, optionally with spaces, dashes or brackets, optional leading +.
var PHONE_RE = /(?:^|[^\d])(\+?\d(?:[\s\-()]?\d){9,10})(?!\d)/;
function findPhone(s) {
  var m = PHONE_RE.exec(s);
  if (!m) return null;
  var phone = normPhone(m[1]);
  if (!phone) return null;
  var at = m.index + m[0].indexOf(m[1]);
  return { phone: phone, index: at, end: at + m[1].length };
}

/* ---------- line cleanup ---------- */
var HEADER_RE = /^\s*\d{2}\.\d{2}\.\d{4},\s+\d{1,2}\D?\d{2}(\s|$)/;  // browser print header: "08.10.2026, 15:13   about:blank"
var FOOTER_RE = /^\s*\S*:\S*\s+\d+\s*\/\s*\d+\s*$/;                // browser print footer: "about:blank   2/2" (URL or title, then page/pages)
var SEP_RE = /^\s*(?:-{5,}|={5,})\s*$/;                            // block separators
var SEP_TITLE_RE = /^\s*={3,}.*={3,}\s*$/;                         // "====== Summary ======"

function cleanLines(text) {
  return String(text == null ? '' : text).replace(/\r/g, '').replace(/\f/g, '\n').split('\n').filter(function (l) {
    return !HEADER_RE.test(l) && !FOOTER_RE.test(l);
  });
}

/* ---------- parsing ---------- */
var WHOM_RE = /Кому\s*:/;                                   // "Кімге/Кому:" (the Kazakh half is not relied on)
var SENDER_RE = /Жібер|(?:^|\s)От\s+кого/i;     // sender label "Жіберуші/От кого:", which the layout may wrap over several lines
var LABEL_ONLY_RE = /^\s*(?:Қайда\s*\/?|Куда\s*:?)\s*$/;
var STOP_RE = /(?:Простая|Итого|Жиынтық|Вид\s+РПО|ТПЖ\s+түрі)/;

function isSep(l) { return SEP_RE.test(l) || SEP_TITLE_RE.test(l); }

function parseKazpostDetailed(text) {
  var lines = cleanLines(text);
  var byTrack = {}, order = [], skipped = 0, total = null;
  var pending = null, cur = null;

  function finish() {
    if (!cur) return;
    var rec = cur; cur = null;
    if (!rec.track) { skipped++; return; }
    var item = { track: rec.track, name: collapse(rec.name), phone: rec.phone || '', address: collapse(rec.addr.join(' ')) };
    var ex = byTrack[item.track];
    if (ex) { // the same parcel listed twice: keep the fuller data
      if (!ex.name && item.name) ex.name = item.name;
      if (!ex.phone && item.phone) ex.phone = item.phone;
      if (item.address.length > ex.address.length) ex.address = item.address;
    } else { byTrack[item.track] = item; order.push(item.track); }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var tot = /Итого\s+сумма\s*:?\s*([\d\s]+(?:[.,]\d{1,2})?)/.exec(line);
    if (tot) { var tn = parseFloat(tot[1].replace(/\s/g, '').replace(',', '.')); if (isFinite(tn)) total = tn; }

    if (isSep(line)) { finish(); continue; }

    var tm = TRACK_RE.exec(line);
    if (tm) { finish(); pending = tm[1]; continue; } // a track number opens the next parcel block

    var wm = WHOM_RE.exec(line);
    if (wm) {
      finish();
      var rest = line.slice(wm.index + wm[0].length);
      var ph = findPhone(rest);
      var nameStr, phone = '';
      if (ph) { nameStr = rest.slice(0, ph.index); phone = ph.phone; }
      else {
        // The phone may wrap to the next line: "SURNAME NAME" / "7771234567".
        var nx = i + 1 < lines.length ? lines[i + 1] : '';
        var nph = nx && !SENDER_RE.test(nx) && !/^\s*\d{6}\s/.test(nx) ? findPhone(nx) : null;
        if (nph) { nameStr = rest + ' ' + nx.slice(0, nph.index); phone = nph.phone; i++; }
        else nameStr = rest;
      }
      cur = { track: pending, name: nameStr, phone: phone, addr: [], collecting: true };
      pending = null;
      continue;
    }

    if (cur && cur.collecting) {
      if (SENDER_RE.test(line) || STOP_RE.test(line)) { cur.collecting = false; continue; }
      var a = collapse(line.replace(/Қайда\s*\/\s*Куда\s*:/, ' ').replace(/(?:^|\s)Куда\s*:/, ' '));
      if (!a || LABEL_ONLY_RE.test(line)) continue;
      cur.addr.push(a);
    }
  }
  finish();
  return { items: order.map(function (t) { return byTrack[t]; }), skipped: skipped, total: total };
}

function parseKazpost(text) { return parseKazpostDetailed(text).items; }

/* ---------- PDF -> text ---------- */
// pages: array of arrays of pdf.js text items ({str, transform:[a,b,c,d,x,y], width, height}).
// Items whose y differs by less than YTOL share a line; each line is sorted by x and padded like `pdftotext -layout`.
function itemsToText(pages) {
  var out = [];
  var YTOL = 2.5;
  pages.forEach(function (items) {
    var rows = [];
    items.filter(function (it) { return it && typeof it.str === 'string' && it.str !== '' && it.transform; })
      .map(function (it) { return { s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10 }; })
      .sort(function (a, b) { return b.y - a.y || a.x - b.x; })
      .forEach(function (it) {
        var row = rows.length ? rows[rows.length - 1] : null;
        if (row && Math.abs(row.y - it.y) <= YTOL) row.items.push(it);
        else rows.push({ y: it.y, items: [it] });
      });
    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.x - b.x; });
      var line = '', endX = null;
      row.items.forEach(function (it) {
        if (endX !== null) {
          var gap = it.x - endX, cw = it.h * 0.5; // approx. width of one character
          var n = gap > it.h * 0.12 ? Math.max(1, Math.min(60, Math.round(gap / cw))) : 0;
          if (n && !/\s$/.test(line) && !/^\s/.test(it.s)) line += new Array(n + 1).join(' ');
        }
        line += it.s;
        endX = Math.max(endX === null ? -Infinity : endX, it.x + it.w);
      });
      out.push(line.replace(/\s+$/, ''));
    });
    out.push('\f');
  });
  return out.join('\n');
}

var pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
    pdfjsPromise.catch(function () { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

// data: ArrayBuffer / Uint8Array of the PDF. lib: pdf.js module (defaults to the vendored copy, browser only).
async function extractPdfText(data, lib) {
  lib = lib || await loadPdfjs();
  var task = lib.getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data), isEvalSupported: false, useSystemFonts: false });
  var doc = await task.promise;
  var pages = [];
  try {
    for (var n = 1; n <= doc.numPages; n++) {
      var page = await doc.getPage(n);
      var tc = await page.getTextContent();
      pages.push(tc.items);
      page.cleanup();
    }
  } finally {
    try { await doc.destroy(); } catch (e) { /* ignore */ }
  }
  return itemsToText(pages);
}

var api = {
  parseKazpost: parseKazpost, parseKazpostDetailed: parseKazpostDetailed, normPhone: normPhone,
  itemsToText: itemsToText, extractPdfText: extractPdfText, TRACK_RE: TRACK_RE
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Kazpost = api;
})(typeof window !== 'undefined' ? window : globalThis);

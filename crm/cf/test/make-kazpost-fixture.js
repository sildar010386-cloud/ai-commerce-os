// Builds the SYNTHETIC Kazpost registry used by the tests (fake people, fake phones, invented streets).
// It imitates the layout of a real registry printed from Chrome (Skia): narrow label column, wrapped labels,
// page header/footer, a parcel block split by a page break, and a summary list repeating every track number.
//   node test/make-kazpost-fixture.js [playwright-module-path] [chromium-path]
// Output: test/fixtures/kazpost-sample.pdf; the text fixture is `pdftotext -layout kazpost-sample.pdf kazpost-sample.txt`.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.argv[2] || 'playwright');

const PARCELS = [
  { track: 'UU000000011KZ', who: 'ИВАНОВА МАРИЯ ПЕТРОВНА 7010000011', a1: '050000 Г. АЛМАТЫ, МКР. ТЕСТОВЫЙ,', a2: 'УЛ. ВЫДУМАННАЯ, 12, КВ. 34', sum: '1470.00' },
  { track: 'UU000000024KZ', who: 'ПЕТРОВ СЕРГЕЙ 87020000022', a1: '010000 Г. АСТАНА, РАЙОН ТЕСТОВЫЙ,', a2: 'ПР. ПРИДУМАННЫЙ, 7, КВ. 5', sum: '1420.00' },
  { track: 'UU000000037KZ', who: 'СИДОРОВА АННА +7 703 000-00-33', a1: '160000 Г. ШЫМКЕНТ, ЕНБЕКШИНСКИЙ РАЙОН,', a2: 'УЛ. ОБРАЗЦОВАЯ, 3', sum: '1330.00' },
  { track: 'UU000000040KZ', who: 'КАСЫМОВ ЕРЛАН 7040000044', a1: '100000 Г. КАРАГАНДА, ГОРОД КАРАГАНДА,', a2: 'УЛ. ПРОБНАЯ, 18, КВ. 71', sum: '1470.00' },
  { track: 'UU000000053KZ', who: 'НУРЛАНОВА АЙГЕРИМ 7050000055', a1: '030000 Г. АКТОБЕ, РАЙОН ТЕСТОВЫЙ,', a2: 'УЛ. ВЫМЫШЛЕННАЯ, 101', sum: '1330.00' },
  { track: 'UU000000066KZ', who: 'ӘЛИЕВ ДАНИЯР 7060000066', a1: '140000 Г. ПАВЛОДАР, ГОРОД ПАВЛОДАР,', a2: 'МКР. ОБРАЗЕЦ, 9, КВ. 2', sum: '1370.00' }
];
const TOTAL = PARCELS.reduce((a, p) => a + parseFloat(p.sum), 0).toFixed(2).replace(/\B(?=(\d{3})+\.)/g, ' ');
const SENDER = 'ИП ТЕСТ ПРОДАВЕЦ';

function block(p, i) {
  const mid = i % 2 ? 'middle' : 'top';
  return `<table class="p"><tr><td colspan="2" class="t">ТПЖ түрі / Вид РПО Посылка, пошта жөнелтілімінің нөмірі / номер почтового отправления № ${p.track}</td></tr>
<tr><td class="l">Салмағы/Вес:</td><td class="v">0.22</td></tr>
<tr><td class="l">Кімге/Кому:</td><td class="v" style="vertical-align:top">${p.who}<br>${p.a1}</td></tr>
<tr><td class="l" style="vertical-align:${mid}">Қайда/Куда:</td><td class="v">${p.a2}</td></tr>
<tr><td class="l">Жіберуші/От кого:</td><td class="v" style="vertical-align:middle">${SENDER}</td></tr>
<tr><td class="l">Простая посылка РК</td><td class="v">${p.sum}</td></tr>
<tr><td class="l">Жиынтық / Итого:</td><td class="v">${p.sum.replace('.00', '')}</td></tr></table><div class="sep">${'-'.repeat(66)}</div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:11px "Liberation Sans","DejaVu Sans",sans-serif;margin:0}
table.p{width:100%;border-collapse:collapse;margin:0}
td{padding:5px 4px;vertical-align:top}
td.l{width:62px}
td.v{padding-left:26px}
td.t{font-size:10px}
div.sep{height:52px;white-space:nowrap;overflow:hidden;margin:4px 0}
tr{page-break-inside:auto}
.top{border-top:2px solid #000;border-bottom:2px solid #000;padding:6px 0;margin-bottom:8px;margin-top:6px}
</style></head><body>
<div class="top">Тестовый реестр посылок (СИНТЕТИКА, вымышленные люди)<br>Қарым-қатынас тізімі / Реестр отправлений от 08.10.2026</div>
${PARCELS.map(block).join('')}
<div class="top">============ Жиынтық тізім / Список отправлений ============</div>
${PARCELS.map((p) => `<div>Түрі / Вид РПО Посылка, номер почтового отправления № ${p.track}</div>`).join('')}
<div>Жиынтық сома / Итого сумма : ${TOTAL}</div>
</body></html>`;

(async () => {
  const b = await chromium.launch({ executablePath: process.argv[3] || undefined, args: ['--no-sandbox'] });
  const pg = await b.newPage();
  await pg.setContent(html);
  const out = path.join(__dirname, 'fixtures', 'kazpost-sample.pdf');
  await pg.pdf({
    path: out, format: 'A4', displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:9px;width:100%;padding:0 30px;display:flex;justify-content:space-between"><span>08.10.2026, 15:13</span><span>about:blank</span></div>',
    footerTemplate: '<div style="font-size:9px;width:100%;padding:0 30px;display:flex;justify-content:space-between"><span>about:blank</span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>',
    margin: { top: '60px', bottom: '60px', left: '36px', right: '36px' }
  });
  await b.close();
  console.log('written', out, fs.statSync(out).size, 'bytes');
})();

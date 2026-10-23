// Unit tests for public/kazpost.js. Run: node --test test/        (Node 20+, no dependencies)
// Optional real-registry check (never committed): KAZPOST_REAL_TXT=/path/r.txt KAZPOST_REAL_PDF=/path/r.pdf node --test test/
// The real check only asserts counts and prints masked values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const K = require('../public/kazpost.js');

const FIX = path.join(__dirname, 'fixtures');
const maskPhone = (p) => (p ? p.slice(0, 3) + '*'.repeat(Math.max(0, p.length - 5)) + p.slice(-2) : '');
const maskTrack = (t) => t.slice(0, 2) + '*'.repeat(6) + t.slice(-5);

const EXPECT = [
  { track: 'UU000000011KZ', name: 'ИВАНОВА МАРИЯ ПЕТРОВНА', phone: '77010000011', city: 'АЛМАТЫ' },
  { track: 'UU000000024KZ', name: 'ПЕТРОВ СЕРГЕЙ', phone: '77020000022', city: 'АСТАНА' },
  { track: 'UU000000037KZ', name: 'СИДОРОВА АННА', phone: '77030000033', city: 'ШЫМКЕНТ' },
  { track: 'UU000000040KZ', name: 'КАСЫМОВ ЕРЛАН', phone: '77040000044', city: 'КАРАГАНДА' },
  { track: 'UU000000053KZ', name: 'НУРЛАНОВА АЙГЕРИМ', phone: '77050000055', city: 'АКТОБЕ' },
  { track: 'UU000000066KZ', name: 'ӘЛИЕВ ДАНИЯР', phone: '77060000066', city: 'ПАВЛОДАР' }
];

function checkSynthetic(r) {
  assert.equal(r.items.length, 6);
  assert.equal(r.skipped, 0);
  assert.equal(r.total, 8390);
  EXPECT.forEach((e, i) => {
    const it = r.items[i];
    assert.equal(it.track, e.track);
    assert.equal(it.name, e.name);
    assert.equal(it.phone, e.phone);
    assert.ok(it.address.includes(e.city), 'address has the city: ' + e.track);
    assert.match(it.address, /^\d{6} /, 'address starts with the postal index');
    assert.ok(!/Жібер|Куда|Қайда|ТЕСТ ПРОДАВЕЦ|about:blank/.test(it.address), 'no labels, sender or page furniture in the address: ' + e.track);
  });
}

test('synthetic registry text (pdftotext -layout): 6 unique parcels, page break and wrapped labels', () => {
  checkSynthetic(K.parseKazpostDetailed(fs.readFileSync(path.join(FIX, 'kazpost-sample.txt'), 'utf8')));
});

test('synthetic registry PDF through pdf.js text items gives the same parcels', async () => {
  const lib = await import(pathToFileURL(path.join(__dirname, '../public/vendor/pdfjs/pdf.min.mjs')).href);
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(__dirname, '../public/vendor/pdfjs/pdf.worker.min.mjs')).href;
  const text = await K.extractPdfText(new Uint8Array(fs.readFileSync(path.join(FIX, 'kazpost-sample.pdf'))), lib);
  checkSynthetic(K.parseKazpostDetailed(text));
});

test('normPhone', () => {
  assert.equal(K.normPhone('7010000011'), '77010000011');
  assert.equal(K.normPhone('87010000011'), '77010000011');
  assert.equal(K.normPhone('+7 (701) 000-00-11'), '77010000011');
  assert.equal(K.normPhone('77010000011'), '77010000011');
  assert.equal(K.normPhone('12345'), '');
  assert.equal(K.normPhone(''), '');
});

test('duplicates are merged, blocks without a track are skipped, a wrapped phone is found', () => {
  const text = [
    ' № UU000000011KZ', ' Кімге/Кому:   ТЕСТОВ ТЕСТ', '                 7010000011', '   050000 Г. АЛМАТЫ, УЛ. ПЕРВАЯ, 1',
    ' Қайда/Куда:', '   КВ. 2', ' Жіберуші/От кого:', ' ТЕСТ', '------------',
    ' Кімге/Кому:   БЕЗ ТРЕКА 7020000022', '   050000 Г. АЛМАТЫ', ' Жіберуші/От кого:', '------------',
    ' № UU000000011KZ', ' Кімге/Кому:   ТЕСТОВ ТЕСТ 87010000011', ' Жіберуші/От кого:'
  ].join('\n');
  const r = K.parseKazpostDetailed(text);
  assert.equal(r.items.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.items[0].phone, '77010000011');
  assert.equal(r.items[0].name, 'ТЕСТОВ ТЕСТ');
  assert.equal(r.items[0].address, '050000 Г. АЛМАТЫ, УЛ. ПЕРВАЯ, 1 КВ. 2');
});

test('browser print header and footer lines are stripped', () => {
  const text = '08.10.2026, 15:13     about:blank\n № UU000000011KZ\n Кімге/Кому: А Б 7010000011\n 050000 Г. АЛМАТЫ\nabout:blank     1/2\n\f08.10.2026, 15:13   about:blank\n УЛ. ВТОРАЯ, 2\n Жіберуші/От кого:\nabout:blank   2/2';
  const r = K.parseKazpost(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].address, '050000 Г. АЛМАТЫ УЛ. ВТОРАЯ, 2');
});

const realTxt = process.env.KAZPOST_REAL_TXT, realPdf = process.env.KAZPOST_REAL_PDF;
test('REAL registry text (local only): 6 unique parcels with track, name and phone', { skip: !realTxt }, () => {
  const r = K.parseKazpostDetailed(fs.readFileSync(realTxt, 'utf8'));
  assert.equal(r.items.length, 6);
  r.items.forEach((it) => {
    assert.match(it.track, /^[A-Z]{2}\d{9}[A-Z]{2}$/);
    assert.ok(it.name.length > 3 && it.phone.length === 11 && it.address.length > 10);
    console.log('  real(txt):', maskTrack(it.track), it.name.charAt(0) + '…', maskPhone(it.phone));
  });
});
test('REAL registry PDF through pdf.js (local only): same 6 parcels', { skip: !realPdf }, async () => {
  const lib = await import(pathToFileURL(path.join(__dirname, '../public/vendor/pdfjs/pdf.min.mjs')).href);
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(__dirname, '../public/vendor/pdfjs/pdf.worker.min.mjs')).href;
  const r = K.parseKazpostDetailed(await K.extractPdfText(new Uint8Array(fs.readFileSync(realPdf)), lib));
  assert.equal(r.items.length, 6);
  r.items.forEach((it) => {
    assert.ok(it.track && it.name && it.phone.length === 11);
    console.log('  real(pdf):', maskTrack(it.track), it.name.charAt(0) + '…', maskPhone(it.phone));
  });
});

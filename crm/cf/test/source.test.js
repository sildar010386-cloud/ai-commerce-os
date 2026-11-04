// Unit tests for src/source.js. Run: node --test test/*.test.js   (Node 20+, no dependencies)
// CommonJS wrapper + dynamic import(): src/ is an ES module (src/package.json), test/ stays CommonJS like kazpost.test.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let detectSource, normalizeText;
before(async () => {
  ({ detectSource, normalizeText } = await import(pathToFileURL(path.join(__dirname, '../src/source.js')).href));
});

const targets = [
  { code: 'A3', product_name: 'Отпариватель Pro', text: 'Здравствуйте! Хочу заказать отпариватель Pro, подскажите цену и доставку', active: 1 },
  { code: 'B7', product_name: 'Утюг Mini', text: 'Добрый день, интересует дорожный утюг Mini', active: 1 },
  { code: 'OLD', product_name: 'Снятый товар', text: 'Хочу снятый с продажи товар номер один', active: 0 }
];

test('normalizeText strips punctuation, emoji, case and yo', () => {
  assert.equal(normalizeText('  Привет!!! Ёлка 🙂, ТЕСТ  '), 'привет елка тест');
  assert.equal(normalizeText(null), '');
});

test('(a) code in parentheses, hash or "код"', () => {
  assert.deepEqual(detectSource({ text: 'Хочу отпариватель (A3)', targets }),
    { traffic: 'target', platform: '', code: 'A3', product: 'Отпариватель Pro' });
  assert.equal(detectSource({ text: 'цена? #b7', targets }).code, 'B7');
  assert.equal(detectSource({ text: 'код a3 пожалуйста', targets }).code, 'A3');
  assert.equal(detectSource({ text: 'Код: B7', targets }).code, 'B7');
});

test('(a) code must be a whole token and the target active', () => {
  assert.equal(detectSource({ text: 'номер #A30', targets }).traffic, 'organic');
  assert.equal(detectSource({ text: 'привет (OLD)', targets }).traffic, 'organic');
  assert.equal(detectSource({ text: 'a3', targets }).traffic, 'organic');
});

test('(b) exact text, case/punctuation/emoji insensitive', () => {
  const r = detectSource({ text: 'здравствуйте хочу заказать ОТПАРИВАТЕЛЬ pro - подскажите цену и доставку 🙏', targets });
  assert.equal(r.traffic, 'target');
  assert.equal(r.code, 'A3');
});

test('(b) 80% word overlap', () => {
  // 10 target words; message misses 2 of them -> 0.8
  const r = detectSource({ text: 'Здравствуйте хочу заказать отпариватель pro цену и доставку', targets });
  assert.equal(r.code, 'A3');
  const low = detectSource({ text: 'Здравствуйте хочу заказать что-то другое', targets });
  assert.equal(low.traffic, 'organic');
});

test('(b) picks the best match and ignores inactive targets', () => {
  const r = detectSource({ text: 'Добрый день, интересует дорожный утюг Mini', targets });
  assert.equal(r.code, 'B7');
  assert.equal(detectSource({ text: 'Хочу снятый с продажи товар номер один', targets }).traffic, 'organic');
});

test('(c) ad referral without a text match', () => {
  const r = detectSource({
    text: 'Привет', targets,
    referral: { source_type: 'ad', source_url: 'https://fb.me/abc', headline: 'Скидки', body: 'Только сегодня' }
  });
  assert.deepEqual(r, { traffic: 'target', platform: 'Facebook', code: '', product: '' });
  assert.equal(detectSource({ text: 'Привет', referral: { source_type: 'ad' }, targets }).platform, 'Instagram');
  assert.equal(detectSource({ text: 'Привет', referral: { source_type: 'ad', source_url: 'https://www.instagram.com/p/x' }, targets }).platform, 'Instagram');
});

test('(c) code found in the ad headline', () => {
  const r = detectSource({ text: 'Привет', targets, referral: { source_type: 'ad', headline: 'Отпариватель (A3) со скидкой' } });
  assert.equal(r.traffic, 'target');
  assert.equal(r.code, 'A3');
  assert.equal(r.product, 'Отпариватель Pro');
});

test('a non-ad referral stays organic', () => {
  const r = detectSource({ text: 'Привет', targets, referral: { source_type: 'post', source_url: 'https://instagram.com/p/1' } });
  assert.equal(r.traffic, 'organic');
  assert.equal(r.platform, 'Instagram');
});

test('(d) organic and robustness', () => {
  assert.deepEqual(detectSource({ text: 'Сколько стоит?', targets }), { traffic: 'organic', platform: '', code: '', product: '' });
  assert.equal(detectSource({}).traffic, 'organic');
  assert.equal(detectSource().traffic, 'organic');
  assert.equal(detectSource({ text: 'x', targets: null }).traffic, 'organic');
  assert.equal(detectSource({ text: '(A3)', targets: [{ code: 'A.3', active: 1, text: '' }] }).traffic, 'organic');
});

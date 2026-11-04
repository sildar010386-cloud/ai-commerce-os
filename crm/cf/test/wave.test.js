// Tests of public/wave.js (voice-note waveform for WhatsApp). Run: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../public/wave.js');

test('bucketize: 64 values 0..100, loudest bucket is 100, silence is zeros', () => {
  const data = new Float32Array(48000);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 10) * (i < 24000 ? 0.2 : 0.8);
  const w = W.bucketize(data, 64);
  assert.equal(w.length, 64);
  assert.ok(w.every((x) => Number.isInteger(x) && x >= 0 && x <= 100));
  assert.equal(Math.max(...w), 100);
  assert.ok(w[5] < w[60] / 2, 'quiet half is lower than the loud half');
  assert.deepEqual(W.bucketize(new Float32Array(1000), 64), new Array(64).fill(0));
});

test('bucketize: short, empty and broken input never throws and keeps 64 slots', () => {
  assert.equal(W.bucketize(new Float32Array(10), 64).length, 64);
  assert.deepEqual(W.bucketize([], 64), new Array(64).fill(0));
  assert.deepEqual(W.bucketize(null), new Array(64).fill(0));
  const w = W.bucketize([0.5, -0.5, NaN, 1], 64);
  assert.equal(w.length, 64);
});

test('bucketize: one click does not flatten the speech (RMS/mean blend)', () => {
  const d = new Float32Array(64000).fill(0.1);
  d[100] = 1;
  const w = W.bucketize(d, 64);
  assert.ok(w[30] > 50, String(w[30]));
});

test('toBase64: 64 bytes -> 88 chars that the Worker accepts', () => {
  const b = W.toBase64(Array.from({ length: 64 }, (_, i) => i));
  assert.equal(b.length, 88);
  assert.match(b, /^[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual([...Buffer.from(b, 'base64')], Array.from({ length: 64 }, (_, i) => i));
});

test('analyseBlob: resolves null where Web Audio is missing', async () => {
  assert.equal(await W.analyseBlob({ arrayBuffer: async () => new ArrayBuffer(4) }), null);
});

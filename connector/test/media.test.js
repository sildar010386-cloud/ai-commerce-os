import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOggOpus, prepareVoice, OGG_OPUS_MIME } from '../src/media.js';

function oggOpus() {
  const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, 1, 0x38, 1]), Buffer.alloc(11)]);
  const page = Buffer.alloc(27 + 1);
  page.write('OggS', 0, 'latin1'); page[26] = 1; page[27] = head.length;
  return Buffer.concat([page, head, Buffer.alloc(40)]);
}

test('isOggOpus recognises an Ogg Opus stream only', () => {
  assert.equal(isOggOpus(oggOpus()), true);
  assert.equal(isOggOpus(Buffer.from('\x1a\x45\xdf\xa3 webm....................................................')), false);
  assert.equal(isOggOpus(Buffer.alloc(10)), false);
});

test('Ogg Opus goes to WhatsApp as is: no conversion, push-to-talk', async () => {
  const buf = oggOpus();
  const r = await prepareVoice(buf, 'audio/ogg;codecs=opus', { convert: async () => { throw new Error('must not be called'); } });
  assert.equal(r.audio, buf); assert.equal(r.ptt, true); assert.equal(r.mimetype, OGG_OPUS_MIME);
});

test('other formats: converted when ffmpeg works', async () => {
  const r = await prepareVoice(Buffer.from('webm'), 'audio/webm', { convert: async () => Buffer.from('converted') });
  assert.equal(r.audio.toString(), 'converted'); assert.equal(r.ptt, true);
});

test('no ffmpeg (Windows): regular audio file, logged', async () => {
  const warns = [];
  const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  const buf = Buffer.from('mp4data');
  const r = await prepareVoice(buf, 'audio/mp4; codecs=mp4a', { convert: async () => { throw err; }, log: { warn: (m) => warns.push(m) } });
  assert.equal(r.audio, buf); assert.equal(r.ptt, false); assert.equal(r.mimetype, 'audio/mp4');
  assert.match(warns[0], /ffmpeg is not installed/);
});

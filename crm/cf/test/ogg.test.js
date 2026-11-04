// Tests of public/ogg.js (WebM/Opus -> Ogg/Opus remux). Run: node --test test/*.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('../public/ogg.js');

const FX = path.join(__dirname, 'fixtures');
const haveFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

// Independent bitwise CRC (poly 0x04C11DB7, no reflection, init 0) - not the table code under test.
function refCrc(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= (b << 24) >>> 0;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) ? (((crc << 1) ^ 0x04C11DB7) >>> 0) : ((crc << 1) >>> 0);
  }
  return crc >>> 0;
}

// Strict Ogg parser: validates every page and returns { pages, packets }.
function parseOgg(buf) {
  const pages = [], packets = [];
  let p = 0, seq = 0, serial = null, partial = [];
  while (p < buf.length) {
    assert.equal(buf.toString('latin1', p, p + 4), 'OggS', 'capture pattern at ' + p);
    assert.equal(buf[p + 4], 0, 'version');
    const type = buf[p + 5];
    const granule = buf.readBigUInt64LE(p + 6);
    const ser = buf.readUInt32LE(p + 14), sq = buf.readUInt32LE(p + 18), crc = buf.readUInt32LE(p + 22);
    const nseg = buf[p + 26];
    const table = [...buf.subarray(p + 27, p + 27 + nseg)];
    const size = 27 + nseg + table.reduce((a, b) => a + b, 0);
    assert.ok(p + size <= buf.length, 'page fits');
    const copy = Buffer.from(buf.subarray(p, p + size)); copy.writeUInt32LE(0, 22);
    assert.equal(refCrc(copy), crc, 'CRC of page ' + sq);
    if (serial === null) serial = ser;
    assert.equal(ser, serial, 'one serial');
    assert.equal(sq, seq++, 'sequence numbers');
    let o = p + 27 + nseg, cur = partial;
    for (const s of table) { cur.push(buf.subarray(o, o + s)); o += s; if (s < 255) { packets.push(Buffer.concat(cur)); cur = []; } }
    partial = cur;
    pages.push({ type, granule, nseg, seq: sq });
    p += size;
  }
  assert.equal(partial.length, 0, 'no unfinished packet at the end');
  return { pages, packets };
}

test('refCrc matches the known Ogg CRC of an empty-checksum page (self-check of the reference)', () => {
  assert.equal(refCrc(Buffer.alloc(0)), 0);
  assert.equal(O.crc32(new Uint8Array([1, 2, 3, 4, 5])), refCrc(Buffer.from([1, 2, 3, 4, 5])));
});

for (const name of ['voice-known.webm', 'voice-live.webm']) {
  test(`${name}: valid Ogg pages, headers, same Opus packets, ffprobe/ffmpeg accept it`, () => {
    const webm = fs.readFileSync(path.join(FX, name));
    const ogg = Buffer.from(O.webmToOgg(new Uint8Array(webm), { serial: 777 }));
    const { pages, packets } = parseOgg(ogg);
    assert.equal(pages[0].type, 0x02, 'BOS on the first page');
    assert.equal(pages.at(-1).type & 0x04, 0x04, 'EOS on the last page');
    assert.equal(pages[0].nseg, 1);
    assert.equal(packets[0].toString('latin1', 0, 8), 'OpusHead');
    assert.equal(packets[0][8], 1);
    assert.equal(packets[1].toString('latin1', 0, 8), 'OpusTags');
    for (let i = 1; i < pages.length; i++) assert.ok(pages[i].granule >= pages[i - 1].granule, 'granule never goes back');
    const audio = packets.slice(2);
    assert.ok(audio.length > 30);
    const direct = O.readWebm(new Uint8Array(webm)).packets;
    assert.equal(audio.length, direct.length);
    audio.forEach((pk, i) => assert.ok(Buffer.from(direct[i]).equals(pk), 'packet ' + i + ' is byte-identical (no re-encoding)'));
    const samples = direct.reduce((a, pk) => a + O.packetSamples(pk), 0);
    assert.equal(pages.at(-1).granule, BigInt(samples));
    if (!haveFfprobe) return;
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-')), 'out.ogg');
    fs.writeFileSync(f, ogg);
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=format_name,duration', '-of', 'json', f]);
    const j = JSON.parse(pr.stdout);
    assert.equal(j.format.format_name, 'ogg');
    assert.equal(j.streams[0].codec_name, 'opus');
    assert.equal(j.streams[0].sample_rate, '48000');
    assert.ok(Math.abs(Number(j.format.duration) - 1.3) < 0.1, 'duration ' + j.format.duration);
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
    assert.equal(dec.status, 0, String(dec.stderr));
    assert.equal(String(dec.stderr).trim(), '', 'ffmpeg finds nothing to complain about');
  });
}

test('live recording (unknown-size segment and cluster) is really what the fixture contains', () => {
  const b = fs.readFileSync(path.join(FX, 'voice-live.webm'));
  const i = b.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  assert.deepEqual([...b.subarray(i + 4, i + 12)], [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
});

// ---- synthetic WebM files ----
const el = (idBytes, payload) => {
  const n = payload.length;
  const size = n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xFF];
  return Buffer.concat([Buffer.from(idBytes), Buffer.from(size), Buffer.from(payload)]);
};
const UNKNOWN = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
const ebml = el([0x1A, 0x45, 0xDF, 0xA3], el([0x42, 0x82], Buffer.from('webm')));
const opusTrack = (num, codec = 'A_OPUS', priv) => el([0xAE], Buffer.concat([
  el([0xD7], [num]), el([0x86], Buffer.from(codec)), priv ? el([0x63, 0xA2], priv) : Buffer.alloc(0), el([0xE1], el([0x9F], [2]))]));
const simple = (track, data, flags = 0x80) => el([0xA3], Buffer.concat([Buffer.from([0x80 | track, 0, 0, flags]), Buffer.from(data)]));
const pkt20 = (n, fill = 1) => Buffer.concat([Buffer.from([0xFC]), Buffer.alloc(n - 1, fill)]);   // CELT FB 20 ms, 1 frame
const webmOf = (tracks, blocks, unknown) => Buffer.concat([ebml,
  unknown ? Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN]) : Buffer.alloc(0),
  el([0x16, 0x54, 0xAE, 0x6B], Buffer.concat(tracks)),
  unknown ? Buffer.concat([Buffer.from([0x1F, 0x43, 0xB6, 0x75]), UNKNOWN, ...blocks]) : el([0x1F, 0x43, 0xB6, 0x75], Buffer.concat(blocks))]);

test('synthetic: other tracks are ignored, BlockGroup blocks are read, CodecPrivate OpusHead is kept, packets > 255 bytes use lacing', () => {
  const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, 2, 0x38, 0x01]), Buffer.from([0x80, 0xBB, 0, 0]), Buffer.from([0, 0, 0])]);
  const big = pkt20(700, 7);
  const w = webmOf([opusTrack(1, 'V_VP8'), opusTrack(2, 'A_OPUS', head)], [
    simple(1, [9, 9, 9]), simple(2, pkt20(10, 1)),
    el([0xA0], Buffer.concat([el([0xA1], Buffer.concat([Buffer.from([0x82, 0, 0, 0]), big]))])), simple(2, pkt20(30, 3))], true);
  const { packets, pages } = parseOgg(Buffer.from(O.webmToOgg(new Uint8Array(w), { serial: 5 })));
  assert.ok(Buffer.from(head).equals(packets[0]), 'OpusHead taken from the file');
  assert.deepEqual(packets.slice(2).map((p) => p.length), [10, 700, 30]);
  assert.ok(packets[3].equals(big));
  assert.equal(pages.at(-1).granule, 3n * 960n);
});

test('synthetic: without CodecPrivate a valid OpusHead is built; many tiny packets are split into pages of at most 255 segments', () => {
  const blocks = [];
  for (let i = 0; i < 400; i++) blocks.push(simple(1, pkt20(3, i & 0xFF)));
  const { packets, pages } = parseOgg(Buffer.from(O.webmToOgg(new Uint8Array(webmOf([opusTrack(1)], blocks, false)), { serial: 9 })));
  assert.equal(packets[0].length, 19);
  assert.equal(packets[0].readUInt16LE(10), 312);
  assert.equal(packets[0].readUInt32LE(12), 48000);
  assert.equal(packets.length, 402);
  assert.ok(pages.length > 8 && pages.every((p) => p.nseg <= 255));
  assert.equal(pages.at(-1).granule, 400n * 960n);
});

test('packet durations follow the TOC byte', () => {
  assert.equal(O.packetSamples(Buffer.from([0x18, 0])), 2880);            // SILK NB 60 ms
  assert.equal(O.packetSamples(Buffer.from([0x78, 0])), 960);             // hybrid FB 20 ms
  assert.equal(O.packetSamples(Buffer.from([0xFC, 0])), 960);            // CELT 20 ms, 1 frame
  assert.equal(O.packetSamples(Buffer.from([0xFD, 0])), 1920);           // two equal frames
  assert.equal(O.packetSamples(Buffer.from([0xFF, 3])), 2880);           // arbitrary number (3) of 20 ms frames
  assert.equal(O.packetSamples(Buffer.from([0x08, 0])), 960);            // SILK NB 20 ms
  assert.equal(O.packetSamples(Buffer.from([0x60, 0])), 480);            // hybrid SWB 10 ms
  assert.equal(O.packetSamples(Buffer.from([0x80, 0])), 120);            // CELT NB 2.5 ms
});

test('rejects what it cannot convert instead of producing garbage', () => {
  assert.throws(() => O.webmToOgg(new Uint8Array([1, 2, 3, 4, 5])), /not a WebM/);
  assert.throws(() => O.webmToOgg(new Uint8Array(webmOf([opusTrack(1, 'A_VORBIS')], [simple(1, pkt20(5))], false))), /no Opus track/);
  assert.throws(() => O.webmToOgg(new Uint8Array(webmOf([opusTrack(1)], [], false))), /no audio/);
  assert.throws(() => O.webmToOgg(new Uint8Array(webmOf([opusTrack(1)], [simple(1, pkt20(5), 0x82)], false))), /laced/);
});

test('toOggBlob: WebM becomes Ogg, other types pass through untouched', async () => {
  const webm = new Blob([fs.readFileSync(path.join(FX, 'voice-live.webm'))], { type: 'audio/webm;codecs=opus' });
  const ogg = await O.toOggBlob(webm);
  assert.equal(ogg.type, 'audio/ogg;codecs=opus');
  assert.equal(Buffer.from(await ogg.arrayBuffer()).toString('latin1', 0, 4), 'OggS');
  const mp4 = new Blob([Buffer.from('x')], { type: 'audio/mp4' });
  assert.equal(await O.toOggBlob(mp4), mp4);
  const already = new Blob([Buffer.from('OggS')], { type: 'audio/ogg;codecs=opus' });
  assert.equal(await O.toOggBlob(already), already);
});

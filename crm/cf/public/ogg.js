/* WebM (Matroska) Opus -> Ogg Opus, without re-encoding.
   Chrome records voice as audio/webm;codecs=opus. WhatsApp wants Ogg/Opus, and a Windows laptop has no ffmpeg, so the browser
   repackages the very same Opus packets into Ogg pages (RFC 3533 / RFC 7845). Plain JS, no dependencies.
   API: OggMux.webmToOgg(Uint8Array[, {serial}]) -> Uint8Array (throws on anything unexpected)
        OggMux.toOggBlob(Blob) -> Promise<Blob>   (a blob that is not WebM/Opus is returned unchanged) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OggMux = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- EBML / Matroska reader ---------- */
  var ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1F43B675, ID_TRACKS = 0x1654AE6B, ID_TRACKENTRY = 0xAE, ID_BLOCKGROUP = 0xA0, ID_AUDIO = 0xE1;
  var ID_SIMPLEBLOCK = 0xA3, ID_BLOCK = 0xA1, ID_CODECPRIVATE = 0x63A2, ID_CODECID = 0x86, ID_TRACKNUMBER = 0xD7, ID_CHANNELS = 0x9F;
  var DESCEND = {};
  DESCEND[ID_SEGMENT] = DESCEND[ID_CLUSTER] = DESCEND[ID_TRACKS] = DESCEND[ID_TRACKENTRY] = DESCEND[ID_BLOCKGROUP] = DESCEND[ID_AUDIO] = true;

  function vintLen(b) { var n = 1, m = 0x80; while (n <= 8 && !(b & m)) { n++; m >>= 1; } return n > 8 ? 0 : n; }
  // Element id: the length marker bit stays part of the id.
  function readId(d, p) {
    var n = vintLen(d[p]);
    if (!n || n > 4 || p + n > d.length) return null;
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + d[p + i];
    return { id: v, len: n };
  }
  // Data size: marker bit removed; null = "unknown size" (all value bits set).
  function readSize(d, p) {
    var n = vintLen(d[p]);
    if (!n || p + n > d.length) return null;
    var v = d[p] & (0xFF >> n), allOnes = v === (0xFF >> n);
    for (var i = 1; i < n; i++) { v = v * 256 + d[p + i]; if (d[p + i] !== 0xFF) allOnes = false; }
    return { size: allOnes ? -1 : v, len: n };
  }
  function uintOf(d, p, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + d[p + i]; return v; }
  function asciiOf(d, p, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(d[p + i]); return s; }

  // -> { head: Uint8Array|null (OpusHead from CodecPrivate), channels, packets: [Uint8Array] }
  function readWebm(d) {
    var tracks = [], cur = null, blocks = [];
    var p = 0, end = d.length;
    if (d.length < 4 || d[0] !== 0x1A || d[1] !== 0x45 || d[2] !== 0xDF || d[3] !== 0xA3) throw new Error('not a WebM file');
    while (p < end) {
      var id = readId(d, p);
      if (!id) break;
      var sz = readSize(d, p + id.len);
      if (!sz) break;
      var dataStart = p + id.len + sz.len;
      if (DESCEND[id.id]) {               // containers are entered even when their size is unknown (live recordings)
        if (id.id === ID_TRACKENTRY) { cur = { number: 0, codec: '', priv: null, channels: 1 }; tracks.push(cur); }
        p = dataStart;
        continue;
      }
      if (sz.size < 0) break;             // unknown size on a non-container: cannot continue
      var dataEnd = dataStart + sz.size;
      if (dataEnd > end) { if (id.id === ID_SIMPLEBLOCK || id.id === ID_BLOCK) break; dataEnd = end; }
      if (cur && id.id === ID_TRACKNUMBER) cur.number = uintOf(d, dataStart, sz.size);
      else if (cur && id.id === ID_CODECID) cur.codec = asciiOf(d, dataStart, sz.size);
      else if (cur && id.id === ID_CODECPRIVATE) cur.priv = d.subarray(dataStart, dataEnd);
      else if (cur && id.id === ID_CHANNELS) cur.channels = uintOf(d, dataStart, sz.size);
      else if (id.id === ID_SIMPLEBLOCK || id.id === ID_BLOCK) {
        var tn = readSize(d, dataStart);
        if (!tn) throw new Error('bad block');
        var flags = d[dataStart + tn.len + 2];
        if (flags & 0x06) throw new Error('laced blocks are not supported');
        blocks.push({ track: tn.size, data: d.subarray(dataStart + tn.len + 3, dataEnd) });
      }
      p = dataEnd;
    }
    var opus = null;
    for (var i = 0; i < tracks.length; i++) if (tracks[i].codec === 'A_OPUS') { opus = tracks[i]; break; }
    if (!opus) throw new Error('no Opus track');
    var packets = [];
    for (var j = 0; j < blocks.length; j++) if (blocks[j].track === opus.number && blocks[j].data.length) packets.push(blocks[j].data);
    if (!packets.length) throw new Error('no audio');
    return { head: opus.priv && opus.priv.length >= 19 && asciiOf(opus.priv, 0, 8) === 'OpusHead' ? opus.priv : null, channels: opus.channels || 1, packets: packets };
  }

  /* ---------- Opus packet duration (RFC 6716 section 3.1), in 48 kHz samples ---------- */
  function packetSamples(pk) {
    var toc = pk[0], config = toc >> 3, c = toc & 3, frame;
    if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
    else if (config < 16) frame = (config & 1) ? 960 : 480;
    else frame = [120, 240, 480, 960][config & 3];
    var n = c === 0 ? 1 : (c === 3 ? (pk.length > 1 ? pk[1] & 0x3F : 1) : 2);
    return frame * n;
  }

  /* ---------- Ogg writer ---------- */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) { var r = i << 24; for (var k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1); t[i] = r >>> 0; }
    return t;
  })();
  function crc32(buf) { var c = 0; for (var i = 0; i < buf.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) & 0xFF) ^ buf[i]]) >>> 0; return c >>> 0; }

  // packets: [Uint8Array] completed on this page (each < 255*255 bytes)
  function makePage(type, granule, serial, seq, packets) {
    var segs = [];
    for (var i = 0; i < packets.length; i++) {
      var n = packets[i].length;
      while (n >= 255) { segs.push(255); n -= 255; }
      segs.push(n);
    }
    if (segs.length > 255) throw new Error('page overflow');
    var body = 0;
    for (var j = 0; j < packets.length; j++) body += packets[j].length;
    var page = new Uint8Array(27 + segs.length + body), dv = new DataView(page.buffer);
    page.set([0x4F, 0x67, 0x67, 0x53, 0, type], 0);                       // "OggS", version 0, header type
    dv.setUint32(6, granule % 4294967296, true); dv.setUint32(10, Math.floor(granule / 4294967296), true);
    dv.setUint32(14, serial >>> 0, true); dv.setUint32(18, seq, true);
    page[26] = segs.length;
    page.set(segs, 27);
    var o = 27 + segs.length;
    for (var k = 0; k < packets.length; k++) { page.set(packets[k], o); o += packets[k].length; }
    dv.setUint32(22, crc32(page), true);                                  // CRC field was zero while computing
    return page;
  }

  function opusHead(channels, existing) {
    if (existing) return existing;
    var h = new Uint8Array(19), dv = new DataView(h.buffer);
    h.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels > 2 ? 2 : channels]);   // "OpusHead", version 1
    dv.setUint16(10, 312, true);                                           // pre-skip
    dv.setUint32(12, 48000, true);                                         // original sample rate (informational)
    return h;
  }
  function opusTags() {
    var vendor = 'bikas-crm', t = new Uint8Array(8 + 4 + vendor.length + 4), dv = new DataView(t.buffer);
    t.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);               // "OpusTags"
    dv.setUint32(8, vendor.length, true);
    for (var i = 0; i < vendor.length; i++) t[12 + i] = vendor.charCodeAt(i);
    dv.setUint32(12 + vendor.length, 0, true);                             // no user comments
    return t;
  }

  function webmToOgg(webm, opts) {
    var w = readWebm(webm);
    var serial = opts && opts.serial != null ? opts.serial : (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : 0x42494B41);
    var pages = [], seq = 0;
    pages.push(makePage(0x02, 0, serial, seq++, [opusHead(w.channels, w.head)]));   // beginning of stream
    pages.push(makePage(0x00, 0, serial, seq++, [opusTags()]));
    var group = [], segCount = 0, granule = 0, i;
    function segsOf(pk) { return Math.floor(pk.length / 255) + 1; }
    function flush(last) {
      if (!group.length) return;
      pages.push(makePage(last ? 0x04 : 0x00, granule, serial, seq++, group));
      group = []; segCount = 0;
    }
    for (i = 0; i < w.packets.length; i++) {
      var pk = w.packets[i];
      if (pk.length >= 255 * 255) throw new Error('packet too large');
      if (group.length && (segCount + segsOf(pk) > 250 || group.length >= 50)) flush(false);
      group.push(pk); segCount += segsOf(pk);
      granule += packetSamples(pk);
    }
    flush(true);
    var total = 0;
    for (i = 0; i < pages.length; i++) total += pages[i].length;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < pages.length; i++) { out.set(pages[i], o); o += pages[i].length; }
    return out;
  }

  // Browser helper: WebM/Opus blob -> audio/ogg;codecs=opus blob; anything else comes back unchanged.
  function toOggBlob(blob) {
    if (!blob || !/webm/i.test(blob.type || '')) return Promise.resolve(blob);
    return blob.arrayBuffer().then(function (ab) {
      return new Blob([webmToOgg(new Uint8Array(ab))], { type: 'audio/ogg;codecs=opus' });
    });
  }

  return { webmToOgg: webmToOgg, toOggBlob: toOggBlob, readWebm: readWebm, packetSamples: packetSamples, crc32: crc32 };
});

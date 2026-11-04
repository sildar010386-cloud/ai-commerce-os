/* Voice-note waveform for WhatsApp: 64 values 0..100 (like the phone app draws) and the duration in seconds.
   WhatsApp shows a flat line when a voice note has no waveform, so the browser computes it from the recording.
   API: Wave.bucketize(Float32Array|number[], n=64) -> number[n] (0..100, loudest bucket = 100)
        Wave.analyseBlob(Blob) -> Promise<{seconds, waveform:number[64]} | null>   (null when the browser cannot decode it)
        Wave.toBase64(number[]) -> string */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Wave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Loudness of each of n equal slices: mean of |x| and RMS blended (peaks matter, but one click must not flatten the rest),
  // then scaled so the loudest slice is 100. Silence gives zeros.
  function bucketize(data, n) {
    n = n || 64;
    var len = data ? data.length : 0, out = [], i, j, max = 0;
    for (i = 0; i < n; i++) {
      var a = Math.floor(len * i / n), b = Math.floor(len * (i + 1) / n), sum = 0, sq = 0, cnt = b - a;
      for (j = a; j < b; j++) { var v = Math.abs(data[j]) || 0; sum += v; sq += v * v; }
      var lvl = cnt > 0 ? 0.5 * (sum / cnt) + 0.5 * Math.sqrt(sq / cnt) : 0;
      out.push(lvl);
      if (lvl > max) max = lvl;
    }
    for (i = 0; i < n; i++) out[i] = max > 0 ? Math.min(100, Math.floor(100 * out[i] / max)) : 0;
    return out;
  }

  function toBase64(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] & 255);
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64');
  }

  // Mix all channels down to one (average) so a stereo recording is not judged by the left ear only.
  function mono(buf) {
    var ch = buf.numberOfChannels, len = buf.length;
    if (ch === 1) return buf.getChannelData(0);
    var out = new Float32Array(len);
    for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < len; i++) out[i] += d[i] / ch; }
    return out;
  }

  function analyseBlob(blob) {
    var AC = typeof self !== 'undefined' && (self.AudioContext || self.webkitAudioContext);
    if (!AC || !blob || !blob.arrayBuffer) return Promise.resolve(null);
    return blob.arrayBuffer().then(function (ab) {
      var ctx = new AC();
      return new Promise(function (resolve, reject) { ctx.decodeAudioData(ab, resolve, reject); }).then(function (buf) {
        try { ctx.close(); } catch (e) { /* ignore */ }
        var secs = Math.max(1, Math.round(buf.duration));
        return { seconds: secs, waveform: bucketize(mono(buf), 64) };
      }, function () { try { ctx.close(); } catch (e) { /* ignore */ } return null; });
    }).catch(function () { return null; });
  }

  return { bucketize: bucketize, toBase64: toBase64, analyseBlob: analyseBlob };
});

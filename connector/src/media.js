// Voice notes. The CRM records Ogg/Opus in the browser, so normally the bytes go to WhatsApp as they are. ffmpeg is only a
// fallback for other formats (Linux server); Windows has none, then the file is sent as a regular audio message.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OGG_OPUS_MIME = 'audio/ogg; codecs=opus';

// Ogg container whose first page carries an OpusHead packet.
export function isOggOpus(buf) {
  if (!buf || buf.length < 47 || buf.toString('latin1', 0, 4) !== 'OggS') return false;
  const nseg = buf[26];
  const start = 27 + nseg;
  return buf.length >= start + 8 && buf.toString('latin1', start, start + 8) === 'OpusHead';
}

export function convertToOpusOgg(input, { ffmpeg = 'ffmpeg', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-voice-'));
    const inFile = path.join(dir, 'in.bin'), outFile = path.join(dir, 'out.ogg');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
    try { fs.writeFileSync(inFile, input); } catch (e) { cleanup(); return reject(e); }
    const p = spawn(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', inFile, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', outFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 2000) err = err.slice(-2000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); cleanup(); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('ffmpeg failed: ' + err.trim().slice(-300));
        resolve(fs.readFileSync(outFile));
      } catch (e) { reject(e); } finally { cleanup(); }
    });
  });
}

// -> the content for sock.sendMessage: a push-to-talk voice note when possible, otherwise a regular audio file.
export async function prepareVoice(buf, mime, { convert = convertToOpusOgg, log = console } = {}) {
  if (isOggOpus(buf)) return { audio: buf, mimetype: OGG_OPUS_MIME, ptt: true };
  try {
    return { audio: await convert(buf), mimetype: OGG_OPUS_MIME, ptt: true };
  } catch (e) {
    const base = String(mime || '').split(';')[0].trim().toLowerCase();
    const why = e && e.code === 'ENOENT' ? 'ffmpeg is not installed' : (e && e.message) || String(e);
    log.warn && log.warn(`voice is not Ogg/Opus (${base || 'unknown'}) and cannot be converted (${why}): sent as a regular audio file`);
    return { audio: buf, mimetype: /^audio\//.test(base) ? base : 'audio/ogg', ptt: false };
  }
}

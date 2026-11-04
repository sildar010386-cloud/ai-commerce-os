// ffmpeg helper: any audio -> ogg/opus mono 48 kHz (what WhatsApp expects for push-to-talk voice notes).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function convertToOpusOgg(input, { ffmpeg = 'ffmpeg', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-voice-'));
    const inFile = path.join(dir, 'in.bin'), outFile = path.join(dir, 'out.ogg');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
    try { fs.writeFileSync(inFile, input); } catch (e) { cleanup(); return reject(e); }
    const p = spawn(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', inFile, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
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

// The connector process itself may run only once per computer: two connectors on one WhatsApp session replace each other
// (stream:error "conflict", code 440). A local TCP port is the lock (the OS frees it when the process dies, even when it is killed);
// a pid file only tells the second copy who the first one is.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const EXIT_ANOTHER_RUNNING = 98;

export function acquireInstance({ port, dir, pid = process.pid, log = () => {} }) {
  const pidFile = dir ? path.join(dir, 'connector.pid') : '';
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      let other = '?';
      try { if (pidFile) other = fs.readFileSync(pidFile, 'utf8').trim() || '?'; } catch (e) { /* unknown */ }
      log(`another connector is running (pid ${other})`);
      resolve({ ok: false, otherPid: other });
    });
    srv.listen(port, '127.0.0.1', () => {
      try { if (pidFile) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(pidFile, String(pid) + '\n'); } } catch (e) { /* only informative */ }
      resolve({ ok: true, release: () => new Promise((r) => { try { srv.close(() => r()); } catch (e) { r(); } try { if (pidFile) fs.rmSync(pidFile, { force: true }); } catch (e) { /* ignore */ } }) });
    });
  });
}

// Exits with the code the supervisor understands when the process is not alone.
export async function ensureSingle({ port, dir, log, exit = (c) => process.exit(c) }) {
  const inst = await acquireInstance({ port, dir, log });
  if (!inst.ok) { exit(EXIT_ANOTHER_RUNNING); return null; }
  return inst;
}

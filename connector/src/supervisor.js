// Supervisor for the Windows install (also works anywhere else): runs the connector (src/index.js) as a child process,
// restarts it when it exits, writes its output to a small rotated log file and, once a day, updates the code from GitHub.
// Started hidden by launcher.vbs (see windows/setup.template.cmd). Exit code 99 = "do not restart me" (another copy runs).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { checkAndUpdate } from './update.js';

export class RotatingLog {
  constructor(file, { maxBytes = 1024 * 1024, keep = 2 } = {}) {
    this.file = file; this.maxBytes = maxBytes; this.keep = keep; this.size = 0;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.size = fs.statSync(file).size; } catch (e) { this.size = 0; }
  }
  rotate() {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      try { if (i === this.keep) fs.rmSync(`${this.file}.${i}`, { force: true }); if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i}`); } catch (e) { /* keep going */ }
    }
    this.size = 0;
  }
  write(text) {
    const data = String(text);
    if (!this.file) { process.stdout.write(data); return; }
    try {
      if (this.size + data.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, data);
      this.size += Buffer.byteLength(data);
    } catch (e) { /* the log must never stop the connector */ }
  }
  line(msg, tag = 'supervisor') { this.write(`${new Date().toISOString()} [${tag}] ${msg}\n`); }
}

// Only one copy per computer may run (two connections with the same WhatsApp session would kick each other out):
// a local TCP port is the lock; the system frees it when the process dies, so there is no stale lock file.
export function acquireLock(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

export function backoffMs(fastCrashes) { return Math.min(60000, 5000 * 2 ** Math.min(fastCrashes, 4)); }

export async function run(env = process.env) {
  const cfg = loadConfig(env);
  const log = new RotatingLog(cfg.logFile);
  const lock = await acquireLock(cfg.lockPort);
  if (!lock) { log.line('another copy is already running: exiting'); return 99; }
  if (!cfg.home) { log.line('BIKAS_HOME is not set'); return 99; }
  log.line(`start; home ${cfg.home}`);

  let child = null, stopping = false, updating = false;
  const entry = path.join(cfg.appDir, 'src', 'index.js');
  const childEnv = () => Object.assign({}, env, cfg.fileVals, { BIKAS_HOME: cfg.home, NODE_ENV: 'production' });
  const pipe = (stream, tag) => {
    let buf = '';
    stream.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { log.line(buf.slice(0, i).replace(/\r$/, ''), tag); buf = buf.slice(i + 1); } });
  };
  const stopChild = () => new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 5000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    try { c.kill(); } catch (e) { clearTimeout(t); resolve(); }
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; stopChild().then(() => process.exit(0)); });

  let updateExit = false;
  const doUpdate = async () => {
    if (!cfg.autoUpdate || updating) return;
    updating = true;
    try {
      const res = await checkAndUpdate({
        home: cfg.home, log: (m) => log.line(m, 'update'),
        // the app folder is replaced: the connector must not run while this happens
        apply: async (a) => { await stopChild(); const { applyUpdate } = await import('./update.js'); return applyUpdate(a); }
      });
      if (res === 'updated') { updateExit = true; stopping = true; await stopChild(); log.line('updated: restarting'); lock.close(); process.exit(0); }
    } catch (e) { log.line('update error: ' + e.message, 'update'); }
    finally { updating = false; }
  };
  setTimeout(doUpdate, 45000);
  setInterval(doUpdate, 24 * 3600 * 1000);

  let fast = 0;
  while (!stopping) {
    if (!fs.existsSync(entry)) { log.line('app is missing: ' + entry); await new Promise((r) => setTimeout(r, 30000)); continue; }
    const started = Date.now();
    log.line('starting the connector');
    await new Promise((resolve) => {
      child = spawn(process.execPath, [entry], { cwd: cfg.appDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      pipe(child.stdout, 'out'); pipe(child.stderr, 'err');
      child.on('error', (e) => { log.line('cannot start: ' + e.message); resolve(); });
      child.on('exit', (code, sig) => { log.line(`connector exited (code ${code}, signal ${sig})`); child = null; resolve(); });
    });
    if (stopping || updateExit) break;
    // an update may be running (the child was stopped on purpose): wait until it is over
    while (updating) await new Promise((r) => setTimeout(r, 1000));
    fast = Date.now() - started < 30000 ? fast + 1 : 0;
    const wait = backoffMs(fast);
    log.line(`restart in ${Math.round(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}

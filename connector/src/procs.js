// Finding and killing leftover connector processes (Windows: killing a parent does not kill its child, so a connector can
// outlive its supervisor and keep using the WhatsApp session). Everything that touches the system is injectable for tests.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = (platform) => platform === 'win32';
const norm = (p, platform) => { const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); return isWin(platform) ? s.toLowerCase() : s; };

// list: [{ pid, ppid, name, exe, cmd }]. Returns the node processes whose executable (or, where the OS does not tell, whose
// command line) lies inside the install folder, except `selfPid`.
export function pickOrphans(list, { home, selfPid, platform = process.platform }) {
  const h = norm(home, platform);
  if (!h) return [];
  const inside = (p) => { const n = norm(p, platform); return n === h || n.startsWith(h + '/'); };
  return (list || []).filter((p) => {
    if (!p || !p.pid || p.pid === selfPid) return false;
    if (!/^node(\.exe)?$/i.test(String(p.name || '').trim())) return false;
    return p.exe ? inside(p.exe) : (!!p.cmd && norm(p.cmd, platform).includes(h + '/'));
  });
}

export function parseWinList(text) {
  let v;
  try { v = JSON.parse(String(text || '').replace(/^﻿/, '').trim() || '[]'); } catch (e) { return []; }
  if (!Array.isArray(v)) v = [v];
  return v.filter((x) => x && x.ProcessId).map((x) => ({ pid: Number(x.ProcessId), ppid: Number(x.ParentProcessId) || 0, name: String(x.Name || ''), exe: String(x.ExecutablePath || ''), cmd: String(x.CommandLine || '') }));
}
export function parsePsList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]), exe: m[3].startsWith('/') ? m[3] : '', cmd: (m[3] + ' ' + m[4]).trim() });
  }
  return out;
}

export function listProcesses({ platform = process.platform, run = spawnSync } = {}) {
  try {
    if (isWin(platform)) {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      return r && r.status === 0 ? parseWinList(r.stdout) : [];
    }
    const r = run('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 10000 });
    return r && r.status === 0 ? parsePsList(r.stdout) : [];
  } catch (e) { return []; }
}

export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill.bind(process) } = {}) {
  if (!pid) return false;
  try {
    if (isWin(platform)) { const r = run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }); return !!r && r.status === 0; }
    kill(pid, 'SIGKILL');
    return true;
  } catch (e) { return false; }
}

// Kills every other node process of this install. Returns the pids it killed.
export function reapOrphans({ home, selfPid = process.pid, platform = process.platform, list = listProcesses, kill = killTree, log = () => {} } = {}) {
  const found = pickOrphans(list({ platform }), { home, selfPid, platform });
  const killed = [];
  for (const p of found) {
    log(`killing a leftover process ${p.pid} (${String(p.cmd || p.exe).slice(0, 120)})`);
    if (kill(p.pid, { platform })) killed.push(p.pid);
  }
  return killed;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { short, describeUpdate, fmtLog, makeBaileysLogger } from '../src/safelog.js';
import { pickOrphans, reapOrphans, parseWinList, parsePsList, killTree, listProcesses } from '../src/procs.js';
import { acquireInstance, ensureSingle, EXIT_ANOTHER_RUNNING } from '../src/instance.js';
import { planRestart } from '../src/supervisor.js';
import { regenerateHelpers } from '../src/update.js';
import { createCrm } from '../src/crm.js';
import { loadConfig } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-single-'));
const HOME = 'C:\\Users\\Owner\\AppData\\Local\\BikasWhatsApp';

test('safelog: truncates to 300 chars and never prints buffers, keys or message content', () => {
  assert.ok(short('x'.repeat(1000)).length <= 303);
  const s = short({ node: { tag: 'message', content: Buffer.from('SECRET-BODY'), attrs: { id: 'A' } }, key: { id: 'K', remoteJid: '7701@s.whatsapp.net' }, message: { conversation: 'hello secret' } });
  assert.ok(!/SECRET|hello|7701|"K"/.test(s), s);
  assert.equal(short(Buffer.alloc(5000)), '<5000 bytes>');
  const line = fmtLog({ node: { tag: 'stream:error', attrs: { code: '515' }, content: [Buffer.from('PAYLOAD')] }, err: { message: 'x'.repeat(900) } }, 'stream errored out');
  assert.ok(line.length <= 303 && !/PAYLOAD/.test(line));
  assert.match(line, /stream errored out/);
  const out = [];
  const lg = makeBaileysLogger((m) => out.push(m));
  lg.child({ a: 1 }).error({ node: { tag: 'message', content: Buffer.from('PAYLOAD') } }, 'bad');
  lg.info({ big: 1 }, 'ignored'); lg.warn('careful');
  assert.equal(out.length, 2);
  assert.ok(!/PAYLOAD/.test(out.join('')));
});

test('safelog: describeUpdate gives state, status code and reason', () => {
  assert.equal(describeUpdate({ connection: 'close', lastDisconnect: { error: { message: 'Stream Errored (conflict)', output: { statusCode: 440 } } } }), 'connection=close code=440 reason="Stream Errored (conflict)"');
  assert.equal(describeUpdate({ qr: 'abc' }), 'qr=issued');
  assert.equal(describeUpdate({ connection: 'open', isNewLogin: true }), 'connection=open newLogin');
});

test('orphans: only node processes running from the install folder, never ourselves, case-insensitive on Windows', () => {
  const list = [
    { pid: 10, name: 'node.exe', exe: HOME + '\\node\\node.exe', cmd: '"' + HOME + '\\node\\node.exe" "' + HOME + '\\app\\src\\supervisor.js"' },
    { pid: 11, name: 'node.exe', exe: HOME.toUpperCase() + '\\NODE\\NODE.EXE', cmd: 'node.exe index.js' },          // old connector, relative command line
    { pid: 12, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node.exe server.js' },          // someone else's node
    { pid: 13, name: 'node.exe', exe: HOME + '-other\\node\\node.exe', cmd: '' },                                  // sibling folder with the same prefix
    { pid: 14, name: 'chrome.exe', exe: HOME + '\\x\\chrome.exe', cmd: '' },
    { pid: 15, name: 'node.exe', exe: HOME + '\\node\\node.exe', cmd: '' }                                          // us
  ];
  assert.deepEqual(pickOrphans(list, { home: HOME, selfPid: 15, platform: 'win32' }).map((p) => p.pid), [10, 11]);
  // posix: the executable is often not known, then the command line decides
  const px = [{ pid: 1, name: 'node', exe: '', cmd: '/opt/bikas/node /opt/bikas/app/src/index.js' }, { pid: 2, name: 'node', exe: '', cmd: 'node /srv/other/app.js' }];
  assert.deepEqual(pickOrphans(px, { home: '/opt/bikas', selfPid: 99, platform: 'linux' }).map((p) => p.pid), [1]);
  assert.deepEqual(pickOrphans(list, { home: '', selfPid: 1, platform: 'win32' }), []);
});

test('reapOrphans kills what it finds and reports the pids (fake process list)', () => {
  const killed = [], lines = [];
  const list = () => [{ pid: 7, name: 'node.exe', exe: HOME + '\\node\\node.exe', cmd: 'index.js' }, { pid: 8, name: 'node.exe', exe: 'D:\\x\\node.exe', cmd: '' }];
  const r = reapOrphans({ home: HOME, selfPid: 1, platform: 'win32', list, kill: (pid) => { killed.push(pid); return true; }, log: (m) => lines.push(m) });
  assert.deepEqual([r, killed], [[7], [7]]);
  assert.match(lines[0], /leftover process 7/);
});

test('process list parsers: Windows JSON (one object or an array), ps output', () => {
  const one = '{"ProcessId":5,"ParentProcessId":4,"Name":"node.exe","ExecutablePath":"C:\\\\a\\\\node.exe","CommandLine":"node.exe x"}';
  assert.equal(parseWinList(one)[0].pid, 5);
  assert.equal(parseWinList('[' + one + ',' + one + ']').length, 2);
  assert.deepEqual(parseWinList(''), []);
  assert.deepEqual(parseWinList('garbage'), []);
  const ps = parsePsList('  100     1 /usr/bin/node /srv/app/src/index.js\n  101   100 sleep 5\n');
  assert.deepEqual([ps[0].pid, ps[0].name, ps[0].exe], [100, 'node', '/usr/bin/node']);
});

test('killTree uses taskkill /T /F on Windows and SIGKILL elsewhere; listProcesses asks PowerShell for node.exe', () => {
  const calls = [];
  assert.equal(killTree(42, { platform: 'win32', run: (...a) => { calls.push(a); return { status: 0 }; } }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['taskkill', ['/PID', '42', '/T', '/F']]);
  const sig = [];
  killTree(43, { platform: 'linux', kill: (p, s) => sig.push([p, s]) });
  assert.deepEqual(sig, [[43, 'SIGKILL']]);
  let seen;
  const out = listProcesses({ platform: 'win32', run: (cmd, args) => { seen = [cmd, args.join(' ')]; return { status: 0, stdout: '[]' }; } });
  assert.deepEqual(out, []);
  assert.equal(seen[0], 'powershell.exe');
  assert.match(seen[1], /Win32_Process/);
  assert.match(seen[1], /ExecutablePath/);
});

test('connector lock: the second copy is refused and names the first one; a freed lock can be taken again', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000), dir = tmp(), msgs = [];
  const a = await acquireInstance({ port, dir, pid: 4321, log: (m) => msgs.push(m) });
  assert.equal(a.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'connector.pid'), 'utf8').trim(), '4321');
  const b = await acquireInstance({ port, dir, pid: 9999, log: (m) => msgs.push(m) });
  assert.equal(b.ok, false);
  assert.match(msgs[0], /another connector is running \(pid 4321\)/);
  let code = null;
  await ensureSingle({ port, dir, log: () => {}, exit: (c) => { code = c; } });
  assert.equal(code, EXIT_ANOTHER_RUNNING);
  await a.release();
  const c = await acquireInstance({ port, dir, pid: 5, log: () => {} });
  assert.equal(c.ok, true);
  await c.release();
});

test('supervisor: exit 98 kills the leftover and retries soon; nothing to kill -> wait 30 s; ordinary crashes keep the backoff', () => {
  assert.deepEqual(planRestart({ code: 98, ranMs: 100, fast: 2, reap: () => [77] }), { fast: 2, wait: 2000, killed: [77] });
  assert.equal(planRestart({ code: 98, ranMs: 100, fast: 0, reap: () => [] }).wait, 30000);
  assert.deepEqual(planRestart({ code: 1, ranMs: 1000, fast: 0, reap: () => { throw new Error('not called'); } }), { fast: 1, wait: 10000, killed: [] });
  assert.deepEqual(planRestart({ code: 1, ranMs: 600000, fast: 3, reap: () => [] }).fast, 0);
});

test('update: helper scripts are regenerated from the downloaded template, idempotently; nothing happens without tools.ps1', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'app', 'windows'), { recursive: true });
  const tpl = fs.readFileSync(new URL('../windows/setup.template.cmd', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(home, 'app', 'windows', 'setup.template.cmd'), tpl);
  assert.deepEqual(regenerateHelpers(home), [], 'Linux install (no tools.ps1): untouched');
  fs.writeFileSync(path.join(home, 'tools.ps1'), 'old');
  const written = regenerateHelpers(home);
  assert.ok(written.includes('tools.ps1') && written.includes('Остановить.cmd'));
  const buf = fs.readFileSync(path.join(home, 'tools.ps1'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM (Russian text in Windows PowerShell 5)');
  const txt = buf.toString('utf8');
  assert.match(txt, /taskkill\.exe \/PID \$p\.ProcessId \/T \/F/);
  assert.match(txt, /ExecutablePath/);
  assert.ok(/\r\n/.test(txt) && !/[^\r]\n/.test(txt), 'CRLF');
  assert.match(fs.readFileSync(path.join(home, 'Запустить.cmd'), 'latin1'), /bikas-tools\.ps1" start\r\n/);
  assert.deepEqual(regenerateHelpers(home), [], 'second run changes nothing');
});

test('crm client sends the instance id in the header, the state body and the outbox query', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) }; };
  const crm = createCrm({ url: 'https://crm.test', token: 't', instanceId: 'abc123def456', fetchImpl });
  await crm.state({ state: 'open' });
  await crm.outbox(true);
  await crm.ack({ id: 1, ok: true });
  assert.equal(JSON.parse(seen[0].init.body).instance, 'abc123def456');
  assert.match(seen[1].url, /outbox\?ready=1&instance=abc123def456$/);
  assert.ok(seen.every((s) => s.init.headers['X-Connector-Instance'] === 'abc123def456'));
  const legacy = createCrm({ url: 'https://crm.test', token: 't', fetchImpl });
  await legacy.outbox(false);
  assert.match(seen.at(-1).url, /outbox\?ready=0$/);
});

test('config: the connector lock port is next to the supervisor one and can be overridden', () => {
  assert.equal(loadConfig({ BIKAS_HOME: '/h' }, { platform: 'linux', readFile: () => { throw new Error('no'); } }).instancePort, 47654);
  assert.equal(loadConfig({ BIKAS_HOME: '/h', BIKAS_INSTANCE_PORT: '5000' }, { platform: 'linux', readFile: () => { throw new Error('no'); } }).instancePort, 5000);
});

// Code delivery for the Windows install: fetch connector/ of the branch from GitHub, install dependencies, swap the app folder.
// Used by the installer (CLI: `node update.js install <home> [--force]`) and by the supervisor (daily self-update).
// SELF-CONTAINED on purpose (Node built-ins only): the installer downloads this single file first, before anything else exists.
//
// Why not the branch zip: the repository also holds videos and images (over 1 GB as a zip). Only the connector/ files
// are downloaded: the commit list gives the latest commit that touched connector/, the git tree lists its files, every file
// comes from raw.githubusercontent.com at that exact commit and its git blob hash is verified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = process.env.BIKAS_REPO_SLUG || 'sildar010386-cloud/ai-commerce-os';
export const BRANCH = process.env.BIKAS_BRANCH || 'claude/practical-mendel-vjtsd5';
const UA = { 'User-Agent': 'bikas-connector', Accept: 'application/vnd.github+json' };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRetry(fetchImpl, url, { tries = 4, sleep = sleepMs, headers = UA } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(Math.min(8000, 1000 * 2 ** (i - 1)));
    try {
      const r = await fetchImpl(url, { headers });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = new Error(`GitHub answered ${r.status} for ${url}`);
      if (r.status === 404 || r.status === 403) break;     // retrying will not help (403 = API rate limit)
    } catch (e) { last = e; }
  }
  throw last;
}

// The newest commit of the branch that changed connector/ -> { sha, tree }.
export async function latestCommit({ fetchImpl = fetch, repo = REPO, branch = BRANCH, sleep } = {}) {
  const url = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=connector&per_page=1`;
  const list = JSON.parse((await getRetry(fetchImpl, url, { sleep })).toString('utf8'));
  const c = Array.isArray(list) && list[0];
  if (!c || !/^[0-9a-f]{40}$/.test(c.sha) || !c.commit || !c.commit.tree) throw new Error('unexpected answer of the GitHub commits API');
  return { sha: c.sha, tree: c.commit.tree.sha };
}

export async function listConnectorFiles({ fetchImpl = fetch, repo = REPO, commit, sleep }) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${commit.tree}?recursive=1`;
  const t = JSON.parse((await getRetry(fetchImpl, url, { sleep })).toString('utf8'));
  if (t.truncated) throw new Error('git tree is truncated');
  return (t.tree || []).filter((e) => e.type === 'blob' && e.path.startsWith('connector/') && !e.path.includes('node_modules/'))
    .map((e) => ({ path: e.path.slice('connector/'.length), sha: e.sha, mode: e.mode }));
}

export function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const safeRel = (p) => !!p && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || /[\\:]/.test(s));

export async function downloadCode({ destDir, commit, files, fetchImpl = fetch, repo = REPO, sleep, log = () => {}, concurrency = 6 }) {
  const list = files || await listConnectorFiles({ fetchImpl, repo, commit, sleep });
  if (!list.some((f) => f.path === 'package.json') || !list.some((f) => f.path === 'src/index.js')) throw new Error('connector/ not found in the commit');
  let next = 0, done = 0;
  async function worker() {
    while (next < list.length) {
      const f = list[next++];
      if (!safeRel(f.path)) throw new Error('unsafe path in the tree: ' + f.path);
      const url = `https://raw.githubusercontent.com/${repo}/${commit.sha}/connector/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const buf = await getRetry(fetchImpl, url, { sleep, headers: { 'User-Agent': 'bikas-connector' } });
      if (gitBlobSha(buf) !== f.sha) throw new Error('checksum mismatch: ' + f.path);
      const out = path.join(destDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      done++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  log(`downloaded ${done} files`);
  return done;
}

/* ---------- machines without git (a Windows laptop): npm cannot fetch git dependencies ---------- */
const GIT_GITHUB = /^git\+(?:https|ssh):\/\/(?:git@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?#([0-9a-f]{40})$/;
// Pure: returns patched copies where github git dependencies come from the codeload tarball of the same commit.
export function patchForNoGit(pkg, lock) {
  const p = JSON.parse(JSON.stringify(pkg)), l = JSON.parse(JSON.stringify(lock));
  let changed = 0;
  for (const [key, entry] of Object.entries(l.packages || {})) {
    const m = key && entry && typeof entry.resolved === 'string' && GIT_GITHUB.exec(entry.resolved);
    if (!m) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const url = `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${m[3]}`;
    p.overrides = Object.assign({}, p.overrides, { [name]: url });
    l.packages[''].overrides = Object.assign({}, l.packages[''].overrides, { [name]: url });
    entry.resolved = url;
    delete entry.integrity;
    changed++;
  }
  return { pkg: p, lock: l, changed };
}
export function gitAvailable() {
  try { return spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0; } catch (e) { return false; }
}
export function patchDirForNoGit(dir) {
  const pf = path.join(dir, 'package.json'), lf = path.join(dir, 'package-lock.json');
  const r = patchForNoGit(JSON.parse(fs.readFileSync(pf, 'utf8')), JSON.parse(fs.readFileSync(lf, 'utf8')));
  if (r.changed) {
    fs.writeFileSync(pf, JSON.stringify(r.pkg, null, 2) + '\n');
    fs.writeFileSync(lf, JSON.stringify(r.lock, null, 2) + '\n');
  }
  return r.changed;
}

/* ---------- npm ---------- */
export function runNpmCi(dir, { stdio = 'ignore', timeoutMs = 15 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const args = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    const env = Object.assign({}, process.env, { npm_config_progress: 'false', npm_config_update_notifier: 'false', PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') });
    const p = fs.existsSync(npmCli)
      ? spawn(process.execPath, [npmCli, ...args], { cwd: dir, env, stdio, windowsHide: true })
      : spawn('npm', args, { cwd: dir, env, stdio, windowsHide: true, shell: process.platform === 'win32' });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('npm ci failed, exit code ' + code)); });
  });
}

/* ---------- install / update ---------- */
const exists = (p) => fs.existsSync(p);
async function renameRetry(a, b, tries = 8) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; } catch (e) { if (i >= tries - 1) throw e; await sleepMs(1000); }   // antivirus may hold files for a moment
  }
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
export const installedVersion = (home) => { try { return fs.readFileSync(path.join(home, 'version.txt'), 'utf8').trim(); } catch (e) { return ''; } };

// Downloads the commit into app.new, installs dependencies, swaps it with app/. The caller must have stopped the running connector.
// The WhatsApp session lives in <home>/data, outside app/, and is never touched.
export async function applyUpdate({ home, commit, force = false, fetchImpl = fetch, repo = REPO, sleep, log = () => {}, stdio = 'ignore', npmCi = runNpmCi, noGit = !gitAvailable() }) {
  const app = path.join(home, 'app'), nw = path.join(home, 'app.new'), old = path.join(home, 'app.old');
  rmrf(nw); rmrf(old);
  fs.mkdirSync(nw, { recursive: true });
  await downloadCode({ destDir: nw, commit, fetchImpl, repo, sleep, log });
  if (noGit) { const n = patchDirForNoGit(nw); if (n) log(`git is not installed: ${n} git dependency taken as a tarball`); }
  const same = !force && exists(path.join(app, 'node_modules', '.package-lock.json')) &&
    exists(path.join(app, 'package-lock.json')) && fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8') === fs.readFileSync(path.join(nw, 'package-lock.json'), 'utf8');
  if (!same) { log('npm ci'); await npmCi(nw, { stdio }); }
  const hadApp = exists(app);
  try {
    if (hadApp) await renameRetry(app, old);
    if (same) await renameRetry(path.join(old, 'node_modules'), path.join(nw, 'node_modules'));
    await renameRetry(nw, app);
  } catch (e) {
    try {
      if (same && exists(path.join(nw, 'node_modules')) && exists(old)) fs.renameSync(path.join(nw, 'node_modules'), path.join(old, 'node_modules'));
      if (hadApp && !exists(app) && exists(old)) fs.renameSync(old, app);
    } catch (e2) { /* nothing more can be done */ }
    throw e;
  }
  fs.writeFileSync(path.join(home, 'version.txt'), commit.sha + '\n');
  rmrf(old);
  regenerateHelpers(home, { log });
  return commit.sha;
}

/* ---------- Windows helper scripts (tools.ps1 and the three .cmd files) ---------- */
// They are written by the installer from connector/windows/setup.template.cmd, which is part of the downloaded code: after an update
// they are rewritten from the new template, so a fix in them reaches the laptop without re-running the installer.
// Does nothing where tools.ps1 does not exist (Linux server). Returns the names of the files written.
export function regenerateHelpers(home, { log = () => {} } = {}) {
  const written = [];
  try {
    const toolsFile = path.join(home, 'tools.ps1');
    const tpl = path.join(home, 'app', 'windows', 'setup.template.cmd');
    if (!exists(toolsFile) || !exists(tpl)) return written;
    const payload = fs.readFileSync(tpl, 'utf8').replace(/\r\n/g, '\n').split(/^#PAYLOAD\s*$/m)[1] || '';
    const m = /\$ToolsPs1 = @'\n([\s\S]*?)\n'@/.exec(payload);
    if (!m) return written;
    const put = (file, text, bom) => {
      const buf = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, bom ? 'utf8' : 'ascii')]);
      let same = false;
      try { same = fs.readFileSync(file).equals(buf); } catch (e) { /* new file */ }
      if (!same) { fs.writeFileSync(file, buf); written.push(path.basename(file)); }
    };
    put(toolsFile, m[1].replace(/\r?\n/g, '\r\n'), true);
    const names = { stop: 'Остановить.cmd', start: 'Запустить.cmd', uninstall: 'Удалить.cmd' };
    for (const [k, name] of Object.entries(names)) {
      put(path.join(home, name), '@echo off\r\ncopy /y "%~dp0tools.ps1" "%TEMP%\\bikas-tools.ps1" >nul\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\\bikas-tools.ps1" ' + k + '\r\npause\r\n', false);
    }
    if (written.length) log('helper scripts regenerated: ' + written.join(', '));
  } catch (e) { log('helper scripts not regenerated: ' + e.message); }
  return written;
}

// -> 'none' (up to date) | 'updated' | 'failed'. A commit that failed is not retried for 24 h.
export async function checkAndUpdate({ home, stopChild = async () => {}, fetchImpl = fetch, repo = REPO, branch = BRANCH, sleep, log = () => {}, now = Date.now, apply = applyUpdate }) {
  let commit;
  try { commit = await latestCommit({ fetchImpl, repo, branch, sleep }); }
  catch (e) { log('update check failed: ' + e.message); return 'failed'; }
  if (commit.sha === installedVersion(home)) return 'none';
  const failFile = path.join(home, 'update.failed');
  try {
    const [sha, at] = fs.readFileSync(failFile, 'utf8').trim().split(' ');
    if (sha === commit.sha && now() - Number(at) < 24 * 3600 * 1000) return 'failed';
  } catch (e) { /* no record */ }
  log(`new version ${commit.sha.slice(0, 7)} (installed ${installedVersion(home).slice(0, 7) || 'none'}): updating`);
  try {
    await apply({ home, commit, fetchImpl, repo, sleep, log });
    try { fs.rmSync(failFile, { force: true }); } catch (e) { /* ignore */ }
    return 'updated';
  } catch (e) {
    log('update failed: ' + e.message);
    try { fs.writeFileSync(failFile, `${commit.sha} ${now()}\n`); } catch (e2) { /* ignore */ }
    return 'failed';
  }
}

async function main(argv) {
  const [cmd, home, ...rest] = argv;
  if (cmd !== 'install' || !home) { console.error('usage: node update.js install <home> [--force]'); return 2; }
  const log = (s) => console.log(s);
  fs.mkdirSync(home, { recursive: true });
  const commit = await latestCommit();
  log(`version ${commit.sha.slice(0, 7)}`);
  await applyUpdate({ home, commit, force: rest.includes('--force'), log, stdio: 'inherit' });
  log('installed');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('ERROR: ' + (e && e.message ? e.message : e)); process.exit(1); });
}

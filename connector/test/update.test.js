import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlobSha, latestCommit, applyUpdate, checkAndUpdate, patchForNoGit, installedVersion } from '../src/update.js';

const connectorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-upd-'));
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40);

// A fake GitHub: serves connector/ of this very checkout (package.json, lock, src/*.js).
function fakeGithub({ sha = SHA, tamper = false } = {}) {
  const files = {};
  const add = (rel) => { files[rel] = fs.readFileSync(path.join(connectorDir, rel)); };
  ['package.json', 'package-lock.json', 'src/index.js', 'src/update.js', 'src/config.js'].forEach(add);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) });
    if (url === 'https://api.github.com/repos/o/r/commits?sha=br%2Fx&path=connector&per_page=1') return ok(JSON.stringify([{ sha, commit: { tree: { sha: TREE } } }]));
    if (url === `https://api.github.com/repos/o/r/git/trees/${TREE}?recursive=1`) {
      const tree = Object.entries(files).map(([p, b]) => ({ path: 'connector/' + p, type: 'blob', mode: '100644', sha: gitBlobSha(b) }));
      tree.push({ path: 'content/huge.mp4', type: 'blob', mode: '100644', sha: 'c'.repeat(40) }, { path: 'connector', type: 'tree', sha: 'd'.repeat(40) });
      return ok(JSON.stringify({ truncated: false, tree }));
    }
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/o\/r\/([0-9a-f]{40})\/connector\/(.+)$/);
    if (m && files[m[2]]) return ok(tamper && m[2] === 'src/index.js' ? Buffer.from('evil') : files[m[2]]);
    return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
  };
  return { fetchImpl, calls, files };
}
const opts = (g, extra) => Object.assign({ fetchImpl: g.fetchImpl, repo: 'o/r', sleep: async () => {} }, extra);

test('gitBlobSha equals git hash-object', () => {
  assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('latestCommit asks the branch + path=connector commits API', async () => {
  const g = fakeGithub();
  assert.deepEqual(await latestCommit(opts(g, { branch: 'br/x' })), { sha: SHA, tree: TREE });
});

test('applyUpdate: only connector/ files are downloaded and verified, app swapped, version written, auth data untouched', async () => {
  const home = tmp(), g = fakeGithub();
  fs.mkdirSync(path.join(home, 'data', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'auth', 'creds.json'), '{"keep":1}');
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'old.txt'), 'old');
  let npmDir = '';
  await applyUpdate(opts(g, { home, commit: { sha: SHA, tree: TREE }, npmCi: async (d) => { npmDir = d; fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', '.package-lock.json'), '{}'); }, noGit: false }));
  assert.ok(npmDir.endsWith('app.new'));
  assert.ok(fs.existsSync(path.join(home, 'app', 'src', 'index.js')));
  assert.ok(!fs.existsSync(path.join(home, 'app', 'old.txt')));
  assert.ok(!fs.existsSync(path.join(home, 'app.new')) && !fs.existsSync(path.join(home, 'app.old')));
  assert.equal(installedVersion(home), SHA);
  assert.equal(fs.readFileSync(path.join(home, 'data', 'auth', 'creds.json'), 'utf8'), '{"keep":1}');
  assert.ok(g.calls.every((u) => !u.includes('huge.mp4')));
  // same lock file again: npm is skipped and node_modules is carried over
  let npmAgain = 0;
  await applyUpdate(opts(g, { home, commit: { sha: SHA, tree: TREE }, npmCi: async () => { npmAgain++; }, noGit: false }));
  assert.equal(npmAgain, 0);
  assert.ok(fs.existsSync(path.join(home, 'app', 'node_modules', '.package-lock.json')));
});

test('applyUpdate: a file whose hash does not match is rejected and the old app stays', async () => {
  const home = tmp(), g = fakeGithub({ tamper: true });
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'old.txt'), 'old');
  await assert.rejects(applyUpdate(opts(g, { home, commit: { sha: SHA, tree: TREE }, npmCi: async () => {}, noGit: false })), /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(home, 'app', 'old.txt'), 'utf8'), 'old');
});

test('patchForNoGit: git dependency becomes a codeload tarball (package.json overrides + lock)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(connectorDir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(connectorDir, 'package-lock.json'), 'utf8'));
  const r = patchForNoGit(pkg, lock);
  assert.equal(r.changed, 1);
  const url = r.lock.packages['node_modules/libsignal'].resolved;
  assert.match(url, /^https:\/\/codeload\.github\.com\/whiskeysockets\/libsignal-node\/tar\.gz\/[0-9a-f]{40}$/);
  assert.equal(r.pkg.overrides.libsignal, url);
  assert.equal(r.lock.packages[''].overrides.libsignal, url);
  assert.equal(JSON.stringify(lock).includes('git+'), true, 'input is not modified');
  assert.equal(JSON.stringify(r.lock).includes('"resolved": "git+'), false);
  assert.equal(patchForNoGit(r.pkg, r.lock).changed, 0, 'idempotent');
});

test('checkAndUpdate: up to date -> none; new commit -> updated; failure is remembered for 24 h', async () => {
  const home = tmp(), g = fakeGithub();
  fs.writeFileSync(path.join(home, 'version.txt'), SHA + '\n');
  const base = opts(g, { home, branch: 'br/x' });
  assert.equal(await checkAndUpdate(base), 'none');
  fs.writeFileSync(path.join(home, 'version.txt'), 'f'.repeat(40) + '\n');
  let applied = 0;
  assert.equal(await checkAndUpdate(Object.assign({}, base, { apply: async () => { applied++; throw new Error('boom'); } })), 'failed');
  assert.equal(await checkAndUpdate(Object.assign({}, base, { apply: async () => { applied++; } })), 'failed', 'not retried at once');
  assert.equal(applied, 1);
  const later = Date.now() + 25 * 3600 * 1000;
  assert.equal(await checkAndUpdate(Object.assign({}, base, { now: () => later, apply: async () => { applied++; } })), 'updated');
  assert.equal(applied, 2);
});

test('ensureDesktopShortcut: Windows only, once (marker), the folder is passed in the environment, failures are logged', async () => {
  const { ensureDesktopShortcut } = await import('../src/update.js');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-sc-'));
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, home: opts.env.BK_HOME }); return { status: 0 }; };
  assert.equal(ensureDesktopShortcut(home, { platform: 'linux', run }), false);
  assert.equal(ensureDesktopShortcut(home, { platform: 'win32', run }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell');
  assert.equal(calls[0].home, home);
  assert.ok(calls[0].args.at(-1).includes("'Bikas WhatsApp.lnk'") && calls[0].args.at(-1).includes('$env:BK_HOME'));
  assert.equal(ensureDesktopShortcut(home, { platform: 'win32', run }), false);   // made once
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-sc-'));
  const logs = [];
  assert.equal(ensureDesktopShortcut(home2, { platform: 'win32', run: () => ({ status: 1 }), log: (m) => logs.push(m) }), false);
  assert.ok(logs[0].includes('not created'));
  assert.equal(ensureDesktopShortcut(home2, { platform: 'win32', run: () => ({ status: 0 }) }), true);   // retried next start
});

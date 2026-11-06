import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { useDurableAuthState, writeFileAtomic } from '../src/authstate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-auth-'));
const deps = { BufferJSON, initAuthCreds, proto };

test('session store: creds and keys survive a reopen; removed keys are gone; leftover .tmp files are cleaned', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'session-x.json.123.tmp'), '{"half":');
  const a = await useDurableAuthState(dir, deps);
  assert.ok(!fs.existsSync(path.join(dir, 'session-x.json.123.tmp')));
  a.state.creds.me = { id: '77011112233:5@s.whatsapp.net' };
  await a.saveCreds();
  await a.state.keys.set({ session: { '7701:1': { k: Buffer.from('abc') } }, 'pre-key': { 5: { keyPair: { public: Buffer.from([1, 2]) } } } });
  await a.state.keys.set({ 'pre-key': { 5: null } });
  await a.flush();
  const b = await useDurableAuthState(dir, deps);
  assert.equal(b.state.creds.me.id, '77011112233:5@s.whatsapp.net');
  const s = await b.state.keys.get('session', ['7701:1']);
  assert.equal(Buffer.from(s['7701:1'].k).toString(), 'abc');
  assert.equal((await b.state.keys.get('pre-key', ['5']))['5'], null);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('session store: writes to one file run in order (the last one wins), flush waits for them', async () => {
  const dir = tmp();
  const a = await useDurableAuthState(dir, deps);
  for (let i = 0; i < 20; i++) a.state.keys.set({ session: { s1: { n: i } } });
  await a.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session-s1.json'), 'utf8')).n, 19);
});

test('atomic write: a write cut off before the rename keeps the previous complete file; a stuck rename falls back to a plain write', async () => {
  const dir = tmp();
  const f = path.join(dir, 'creds.json');
  fs.writeFileSync(f, '{"ok":1}');
  const failing = { writeFile: async (p, d) => { if (p.endsWith('.tmp')) { fs.writeFileSync(p, String(d).slice(0, 3)); throw new Error('killed'); } }, rename: fsRename, unlink: async () => {} };
  await assert.rejects(writeFileAtomic(f, '{"ok":2}', { fs: failing }));
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ok":1}');
  const busy = { writeFile: (p, d) => fs.promises.writeFile(p, d), rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, unlink: (p) => fs.promises.unlink(p) };
  await writeFileAtomic(f, '{"ok":3}', { fs: busy, wait: async () => {} });
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ok":3}');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), []);
});
function fsRename(a, b) { return fs.promises.rename(a, b); }

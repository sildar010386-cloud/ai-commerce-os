import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RotatingLog, acquireLock, backoffMs } from '../src/supervisor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bikas-sup-'));

test('RotatingLog rotates by size and keeps a bounded number of files', () => {
  const dir = tmp(), f = path.join(dir, 'connector.log');
  const log = new RotatingLog(f, { maxBytes: 200, keep: 2 });
  for (let i = 0; i < 60; i++) log.line('message number ' + i);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['connector.log', 'connector.log.1', 'connector.log.2']);
  for (const x of files) assert.ok(fs.statSync(path.join(dir, x)).size <= 260);
  assert.match(fs.readFileSync(f, 'utf8'), /message number 59/);
});

test('single instance lock: the second one does not get the port, a freed port can be taken again', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const a = await acquireLock(port);
  assert.ok(a);
  assert.equal(await acquireLock(port), null);
  await new Promise((r) => a.close(r));
  const b = await acquireLock(port);
  assert.ok(b);
  await new Promise((r) => b.close(r));
});

test('backoff grows with fast crashes and is capped at one minute', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffMs), [5000, 10000, 20000, 40000, 60000, 60000]);
});

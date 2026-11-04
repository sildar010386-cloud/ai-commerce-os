import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseEnvFile } from '../src/config.js';

test('parseEnvFile: comments, quotes, CRLF, BOM', () => {
  assert.deepEqual(parseEnvFile('\uFEFF# c\r\nCRM_URL=https://a.b\r\nCONNECTOR_TOKEN="t-1"\r\n\r\nX = y z\r\n'), { CRM_URL: 'https://a.b', CONNECTOR_TOKEN: 't-1', X: 'y z' });
});

test('Linux defaults are unchanged (systemd server)', () => {
  const c = loadConfig({ CRM_URL: 'https://c', CONNECTOR_TOKEN: 't' }, { platform: 'linux', readFile: () => { throw new Error('none'); } });
  assert.equal(c.stateDir, '/var/lib/bikas-connector');
  assert.equal(c.authDir, '/var/lib/bikas-connector/auth');
  assert.equal(c.queueFile, '/var/lib/bikas-connector/queue.jsonl');
  assert.equal(c.envFile, '/etc/bikas-connector.env');
  assert.equal(c.logFile, '');
});

test('Windows defaults live inside %LOCALAPPDATA%\\BikasWhatsApp (Cyrillic user, spaces)', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Иван Петров\\AppData\\Local' };
  const files = { 'C:\\Users\\Иван Петров\\AppData\\Local\\BikasWhatsApp\\config.env': 'CRM_URL=https://crm.example\r\nCONNECTOR_TOKEN=abc\r\nBIKAS_AUTOUPDATE=1\r\n' };
  const c = loadConfig(env, { platform: 'win32', readFile: (f) => { if (files[f]) return files[f]; throw new Error('ENOENT ' + f); } });
  const home = 'C:\\Users\\Иван Петров\\AppData\\Local\\BikasWhatsApp';
  assert.equal(c.home, home);
  assert.equal(c.stateDir, home + '\\data');
  assert.equal(c.authDir, home + '\\data\\auth');
  assert.equal(c.queueFile, home + '\\data\\queue.jsonl');
  assert.equal(c.logFile, home + '\\connector.log');
  assert.equal(c.appDir, home + '\\app');
  assert.equal(c.crmUrl, 'https://crm.example');
  assert.equal(c.token, 'abc');
  assert.equal(c.autoUpdate, true);
});

test('environment overrides every path and wins over the env file', () => {
  const env = { BIKAS_HOME: 'D:\\B', ENV_FILE: 'D:\\x.env', STATE_DIR: 'D:\\s', AUTH_DIR: 'D:\\a', QUEUE_FILE: 'D:\\q.jsonl', LOG_FILE: 'D:\\l.log', CONNECTOR_TOKEN: 'fromenv', WATCHDOG_MINUTES: '9' };
  const c = loadConfig(env, { platform: 'win32', readFile: () => 'CONNECTOR_TOKEN=fromfile\nCRM_URL=https://f' });
  assert.deepEqual([c.envFile, c.stateDir, c.authDir, c.queueFile, c.logFile], ['D:\\x.env', 'D:\\s', 'D:\\a', 'D:\\q.jsonl', 'D:\\l.log']);
  assert.equal(c.token, 'fromenv');
  assert.equal(c.crmUrl, 'https://f');
  assert.equal(c.watchdogMinutes, 9);
});

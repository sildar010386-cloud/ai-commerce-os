// Paths and settings of the connector. One place, driven by the environment, so that the same code runs under systemd
// (Linux server: /etc/bikas-connector.env, /var/lib/bikas-connector) and on a Windows laptop (everything inside the
// install folder %LOCALAPPDATA%\BikasWhatsApp, found through BIKAS_HOME or LOCALAPPDATA).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

// env: process.env-like. The env file only fills in what the real environment does not set.
export function loadConfig(env = process.env, { platform = process.platform, readFile = (f) => fs.readFileSync(f, 'utf8'), homedir = os.homedir() } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let home = env.BIKAS_HOME || '';
  if (!home && platform === 'win32') home = P.join(env.LOCALAPPDATA || P.join(homedir, 'AppData', 'Local'), 'BikasWhatsApp');
  const envFile = env.ENV_FILE || (home ? P.join(home, 'config.env') : '/etc/bikas-connector.env');
  let fileVals = {};
  try { fileVals = parseEnvFile(readFile(envFile)); } catch (e) { /* no file: the environment has to be enough */ }
  const get = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : fileVals[k]);
  const stateDir = get('STATE_DIR') || (home ? P.join(home, 'data') : '/var/lib/bikas-connector');
  return {
    platform, home, envFile, fileVals,
    crmUrl: get('CRM_URL') || '',
    token: get('CONNECTOR_TOKEN') || '',
    stateDir,
    authDir: get('AUTH_DIR') || P.join(stateDir, 'auth'),
    queueFile: get('QUEUE_FILE') || P.join(stateDir, 'queue.jsonl'),
    logFile: get('LOG_FILE') || (home ? P.join(home, 'connector.log') : ''),
    appDir: home ? P.join(home, 'app') : '',
    autoUpdate: get('BIKAS_AUTOUPDATE') === '1',
    watchdogMinutes: Math.max(1, Number(get('WATCHDOG_MINUTES')) || 5),
    lockPort: Number(get('BIKAS_LOCK_PORT')) || 47653
  };
}

// Entry point: wires Baileys, the CRM client and the bridge together. Config comes from the environment (systemd
// EnvironmentFile=/etc/bikas-connector.env on Linux, config.env in the install folder on Windows): CRM_URL, CONNECTOR_TOKEN,
// optional STATE_DIR / AUTH_DIR / QUEUE_FILE / LOG_FILE / ENV_FILE / BIKAS_HOME (see config.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import makeWASocket, { fetchLatestBaileysVersion, downloadMediaMessage, downloadHistory, Browsers, BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { useDurableAuthState } from './authstate.js';
import { createCrm } from './crm.js';
import { createEventQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { prepareVoice } from './media.js';
import { loadConfig } from './config.js';
import { installedVersion } from './update.js';
import { makeBaileysLogger, short } from './safelog.js';
import { acquireInstance, EXIT_ANOTHER_RUNNING } from './instance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
// The version shown in the CRM (Настройки → Подключение WhatsApp): package version + the installed commit, e.g. 1.0.0+7e0d228,
// so a screenshot tells which update is on the computer.
const cfg0 = loadConfig(process.env);
const commit = cfg0.home ? installedVersion(cfg0.home).slice(0, 7) : '';
const VERSION = pkg.version + (commit ? '+' + commit : '');

const cfg = loadConfig(process.env);
const CRM_URL = cfg.crmUrl, TOKEN = cfg.token, STATE_DIR = cfg.stateDir, AUTH_DIR = cfg.authDir;
if (!/^https?:\/\//.test(CRM_URL) || !TOKEN) {
  console.error(`CRM_URL and CONNECTOR_TOKEN must be set (environment or ${cfg.envFile})`);
  process.exit(2);
}

// Plain one-line messages on stdout: the supervisor prefixes the time and writes them to connector.log.
const line = (tag) => (m) => console.log(tag + short(m, 400));
const onBaileysError = { fn: null };                           // set to the bridge below (messages Baileys drops undecrypted)
const logger = makeBaileysLogger(line(''), 'warn', (o, m) => onBaileysError.fn && onBaileysError.fn(o, m));   // Baileys: compact warn/error lines, no payloads
const appLog = { info: line(''), warn: line('WARN '), error: line('ERROR ') };

// Only one connector per computer: two processes on one WhatsApp session replace each other. Taken BEFORE the auth folder is touched.
fs.mkdirSync(STATE_DIR, { recursive: true });
const instanceLock = await acquireInstance({ port: cfg.instancePort, dir: STATE_DIR, log: (m) => console.log(m) });
if (!instanceLock.ok) process.exit(EXIT_ANOTHER_RUNNING);
fs.mkdirSync(AUTH_DIR, { recursive: true });

const INSTANCE_ID = crypto.randomBytes(6).toString('hex');   // new on every start; sent to the CRM in every call
appLog.info(`connector ${VERSION} started: pid ${process.pid}, instance ${INSTANCE_ID}`);
// Windows does not kill a child with its parent: leave when the supervisor that started us is gone.
const parentPid = Number(process.env.BIKAS_PARENT_PID) || 0;
if (parentPid) {
  setInterval(() => {
    let alive = true;
    try { process.kill(parentPid, 0); } catch (e) { alive = e && e.code === 'EPERM'; }
    if (!alive) { appLog.info('the supervisor is gone: exiting'); process.exit(0); }
  }, 5000).unref();
}
const crm = createCrm({ url: CRM_URL, token: TOKEN, instanceId: INSTANCE_ID, log: logger });
const queue = createEventQueue({ file: cfg.queueFile, send: (events) => crm.events(events), log: appLog });

const FULL_SYNC = process.env.SYNC_FULL_HISTORY === '1';
const voiceHint = { current: null };
const bridgeRef = { current: null };
let waVersion;
let auth = null;    // the session store of the current socket (flushed before a planned stop)
async function makeSocket() {
  auth = await useDurableAuthState(AUTH_DIR, { BufferJSON, initAuthCreds, proto });
  const { state, saveCreds } = auth;
  if (!waVersion) {
    try { waVersion = (await fetchLatestBaileysVersion()).version; } catch (e) { waVersion = undefined; }
  }
  const sock = makeWASocket({
    auth: state,
    version: waVersion,
    logger,
    // Field report 2026-11-04: Browsers.windows('Desktop') + syncFullHistory makes Baileys announce webSubPlatform WIN32
    // (validate-connection.js getWebInfo) and WhatsApp closes every connection at once (code 428 "Connection Terminated"),
    // even with a fresh session, so no QR is ever shown. The first install (windows/Chrome, no full sync) paired fine.
    // Default = that proven WhatsApp Web identity; the phone still sends the initial + recent history on pairing, and
    // shouldSyncHistoryMessage: () => true makes Baileys keep it (its default drops it when syncFullHistory is off).
    // SYNC_FULL_HISTORY=1 opts into the macOS desktop identity (webSubPlatform DARWIN) for a deeper sync — experimental.
    browser: FULL_SYNC ? Browsers.macOS('Desktop') : Browsers.windows('Chrome'),
    markOnlineOnConnect: false,          // keep push notifications on the owner's phone
    syncFullHistory: FULL_SYNC,
    shouldSyncHistoryMessage: () => true,
    patchMessageBeforeSending: (msg) => {
      // Voice-note waveform (see bridge.js voiceHint): Baileys overwrites it with undefined when it cannot decode the audio.
      const hint = voiceHint.current;
      if (hint && msg && msg.audioMessage && msg.audioMessage.ptt) {
        return Object.assign({}, msg, { audioMessage: Object.assign({}, msg.audioMessage, { waveform: hint.waveform, seconds: hint.seconds }) });
      }
      return msg;
    },
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => (bridgeRef.current ? bridgeRef.current.getSentMessage(key) : undefined)   // retries: see bridge.js sentStore
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

async function wipeAuth() {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const bridge = createBridge({
  crm, queue, makeSocket, wipeAuth, voiceHint, version: VERSION, stateDir: STATE_DIR, log: appLog,
  encodeMessage: (m) => Buffer.from(proto.Message.encode(proto.Message.fromObject(m)).finish()).toString('base64'),
  decodeMessage: (b) => proto.Message.decode(Buffer.from(b, 'base64')),
  renderQr: (qr) => QRCode.toDataURL(qr, { width: 360, margin: 2, errorCorrectionLevel: 'M' }),
  downloadHistory: (n, opts) => downloadHistory(n, opts),
  downloadMedia: (m, sock) => downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
  prepareVoice: (buf, mime) => prepareVoice(buf, mime, { log: logger }),
  watchdogMs: cfg.watchdogMinutes * 60000
});

bridgeRef.current = bridge;
onBaileysError.fn = (o, m) => bridge.onDecryptError(o, m);
bridge.start();
// A planned stop (update, Остановить.cmd, the supervisor restarting us) lets the session files finish writing first: a key file
// cut in half makes that chat's messages undecryptable. The supervisor asks over IPC (on Windows a signal is a hard kill).
let stopping = false;
async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  appLog.info(`stopping (${why})`);
  try { await bridge.stop(); } catch (e) { /* ignore */ }
  try { if (auth) await auth.flush(3000); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 200);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
process.on('message', (m) => { if (m && m.cmd === 'stop') shutdown('asked by the supervisor'); });
process.on('disconnect', () => shutdown('the supervisor is gone'));
process.on('unhandledRejection', (e) => appLog.error('unhandledRejection: ' + short(e && e.message, 200)));
process.on('uncaughtException', (e) => { appLog.error('uncaughtException: ' + short(e && e.message, 200)); setTimeout(() => process.exit(1), 300); });

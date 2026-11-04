// Entry point: wires Baileys, the CRM client and the bridge together. Config comes from the environment (systemd
// EnvironmentFile=/etc/bikas-connector.env on Linux, config.env in the install folder on Windows): CRM_URL, CONNECTOR_TOKEN,
// optional STATE_DIR / AUTH_DIR / QUEUE_FILE / LOG_FILE / ENV_FILE / BIKAS_HOME (see config.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys';
import { createCrm } from './crm.js';
import { createEventQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { prepareVoice } from './media.js';
import { loadConfig } from './config.js';
import { makeBaileysLogger, short } from './safelog.js';
import { acquireInstance, EXIT_ANOTHER_RUNNING } from './instance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

const cfg = loadConfig(process.env);
const CRM_URL = cfg.crmUrl, TOKEN = cfg.token, STATE_DIR = cfg.stateDir, AUTH_DIR = cfg.authDir;
if (!/^https?:\/\//.test(CRM_URL) || !TOKEN) {
  console.error(`CRM_URL and CONNECTOR_TOKEN must be set (environment or ${cfg.envFile})`);
  process.exit(2);
}

// Plain one-line messages on stdout: the supervisor prefixes the time and writes them to connector.log.
const line = (tag) => (m) => console.log(tag + short(m, 400));
const logger = makeBaileysLogger(line(''), 'warn');            // Baileys: compact warn/error lines, no payloads
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
const queue = createEventQueue({ file: cfg.queueFile, send: (events) => crm.events(events), log: logger });

const voiceHint = { current: null };
let waVersion;
async function makeSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (!waVersion) {
    try { waVersion = (await fetchLatestBaileysVersion()).version; } catch (e) { waVersion = undefined; }
  }
  const sock = makeWASocket({
    auth: state,
    version: waVersion,
    logger,
    // WhatsApp sends the old chats (like WhatsApp Web does) only to a linked "desktop" companion that asks for the full history
    // at pairing time: platform "Desktop" + os Windows/Mac OS + syncFullHistory (see Baileys validate-connection.js).
    // Without shouldSyncHistoryMessage Baileys would still drop every history chunk (its default follows syncFullHistory).
    browser: Browsers.windows('Desktop'),
    markOnlineOnConnect: false,          // keep push notifications on the owner's phone
    syncFullHistory: process.env.SYNC_FULL_HISTORY !== '0',
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
    getMessage: async () => undefined
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
  renderQr: (qr) => QRCode.toDataURL(qr, { width: 360, margin: 2, errorCorrectionLevel: 'M' }),
  downloadMedia: (m, sock) => downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
  prepareVoice: (buf, mime) => prepareVoice(buf, mime, { log: logger }),
  watchdogMs: cfg.watchdogMinutes * 60000
});

bridge.start();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { bridge.stop(); setTimeout(() => process.exit(0), 300); });
process.on('unhandledRejection', (e) => appLog.error('unhandledRejection: ' + short(e && e.message, 200)));
process.on('uncaughtException', (e) => { appLog.error('uncaughtException: ' + short(e && e.message, 200)); setTimeout(() => process.exit(1), 300); });

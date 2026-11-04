// Entry point: wires Baileys, the CRM client and the bridge together. Config comes from the environment (systemd
// EnvironmentFile=/etc/bikas-connector.env on Linux, config.env in the install folder on Windows): CRM_URL, CONNECTOR_TOKEN,
// optional STATE_DIR / AUTH_DIR / QUEUE_FILE / LOG_FILE / ENV_FILE / BIKAS_HOME (see config.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys';
import { createCrm } from './crm.js';
import { createEventQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { prepareVoice } from './media.js';
import { loadConfig } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

const cfg = loadConfig(process.env);
const CRM_URL = cfg.crmUrl, TOKEN = cfg.token, STATE_DIR = cfg.stateDir, AUTH_DIR = cfg.authDir;
if (!/^https?:\/\//.test(CRM_URL) || !TOKEN) {
  console.error(`CRM_URL and CONNECTOR_TOKEN must be set (environment or ${cfg.envFile})`);
  process.exit(2);
}
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const logger = pino({ level: 'warn' });          // Baileys is chatty below warn
const appLog = pino({ level: 'info' });          // the bridge's own progress lines (history import)
const crm = createCrm({ url: CRM_URL, token: TOKEN, log: logger });
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
process.on('unhandledRejection', (e) => logger.error('unhandledRejection: ' + (e && e.message)));
process.on('uncaughtException', (e) => { logger.error('uncaughtException: ' + (e && e.message)); setTimeout(() => process.exit(1), 300); });

// Entry point: wires Baileys, the CRM client and the bridge together. Config comes from the environment
// (systemd EnvironmentFile=/etc/bikas-connector.env): CRM_URL, CONNECTOR_TOKEN, optional AUTH_DIR / STATE_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys';
import { createCrm } from './crm.js';
import { createEventQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { convertToOpusOgg } from './media.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

const CRM_URL = process.env.CRM_URL || '';
const TOKEN = process.env.CONNECTOR_TOKEN || '';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/bikas-connector';
const AUTH_DIR = process.env.AUTH_DIR || path.join(STATE_DIR, 'auth');
if (!/^https?:\/\//.test(CRM_URL) || !TOKEN) {
  console.error('CRM_URL and CONNECTOR_TOKEN must be set (see /etc/bikas-connector.env)');
  process.exit(2);
}
fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: 'warn' });
const crm = createCrm({ url: CRM_URL, token: TOKEN, log: logger });
const queue = createEventQueue({ file: path.join(STATE_DIR, 'queue.jsonl'), send: (events) => crm.events(events), log: logger });

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
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,          // keep push notifications on the owner's phone
    syncFullHistory: process.env.SYNC_FULL_HISTORY === '1',
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
  crm, queue, makeSocket, wipeAuth, version: VERSION, stateDir: STATE_DIR, log: logger,
  renderQr: (qr) => QRCode.toDataURL(qr, { width: 360, margin: 2, errorCorrectionLevel: 'M' }),
  downloadMedia: (m, sock) => downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
  convertVoice: (buf) => convertToOpusOgg(buf)
});

bridge.start();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { bridge.stop(); setTimeout(() => process.exit(0), 300); });
process.on('unhandledRejection', (e) => logger.error('unhandledRejection: ' + (e && e.message)));

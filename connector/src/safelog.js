// Compact, safe log text. Baileys errors and nodes can carry message payloads, buffers and keys: none of that may reach connector.log.
export function short(x, max = 300) {
  let s;
  if (x == null) s = '';
  else if (typeof x === 'string') s = x;
  else if (x instanceof Error) s = (x.name && x.name !== 'Error' ? x.name + ': ' : '') + x.message;
  else if (Buffer.isBuffer(x) || x instanceof Uint8Array) s = `<${x.length} bytes>`;
  else {
    try { s = JSON.stringify(x, (k, v) => (v && (v.type === 'Buffer' || v instanceof Uint8Array || Buffer.isBuffer(v)) ? '<bytes>' : (k === 'key' || k === 'message' || k === 'content' || k === 'data') ? '<hidden>' : v)); }
    catch (e) { s = String(x); }
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// One line about a connection.update: connection, whether a QR came, and for a close the status code and reason text.
export function describeUpdate(u) {
  const parts = [];
  if (u && u.connection) parts.push('connection=' + u.connection);
  if (u && u.qr) parts.push('qr=issued');
  if (u && u.isNewLogin) parts.push('newLogin');
  const err = u && u.lastDisconnect && u.lastDisconnect.error;
  if (err) {
    const code = err.output && err.output.statusCode;
    parts.push('code=' + (code == null ? '?' : code), 'reason="' + short(err.message || (err.output && err.output.payload && err.output.payload.message) || '', 120) + '"');
  }
  return parts.join(' ');
}

// A pino-like line for the Baileys logger: the message text and the error text, never node contents, keys or buffers.
export function fmtLog(obj, msg) {
  const parts = [];
  if (typeof msg === 'string' && msg) parts.push(msg);
  if (typeof obj === 'string') parts.push(obj);
  else if (obj && typeof obj === 'object') {
    const err = obj.err || obj.error;
    if (err) parts.push('error: ' + short(err.message || err, 150));
    if (obj.node && obj.node.tag) parts.push('node=' + obj.node.tag + (obj.node.attrs && (obj.node.attrs.type || obj.node.attrs.code) ? '/' + (obj.node.attrs.type || obj.node.attrs.code) : ''));
    if (!err && !obj.node) parts.push(short(obj, 200));
  }
  return short(parts.join(' | '), 300);
}

// ILogger for Baileys that writes compact lines through `write` (warn and error only).
export function makeBaileysLogger(write, level = 'warn') {
  const mk = () => ({
    level,
    child: () => mk(),
    trace() {}, debug() {}, info() {},
    warn: (o, m) => write('baileys warn: ' + fmtLog(o, m)),
    error: (o, m) => write('baileys error: ' + fmtLog(o, m))
  });
  return mk();
}

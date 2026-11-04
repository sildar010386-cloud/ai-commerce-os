// WhatsApp Cloud API webhook parser. Pure functions, never throw on unexpected shapes.
// Output events (ts is an ISO-8601 UTC string):
//   {kind:'message'|'echo'|'history', direction:'in'|'out', phoneNumberId, displayPhone, waId, profileName,
//    msg:{id, ts, type, body, mediaId, mime, caption, voice, referral}}
//   {kind:'status', phoneNumberId, id, status, ts}
// Connector (QR) events may also carry msg.mediaRef: id of a file stored in the CRM media table.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const s = (v) => (v == null ? '' : String(v));
const digits = (v) => s(v).replace(/\D/g, '');

function isoFromTs(t) {
  const n = Number(t);
  if (isFinite(n) && n > 0) {
    const d = new Date(n < 1e12 ? n * 1000 : n);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// Normalises one Cloud API message object.
export function parseMessage(m) {
  const out = { id: '', ts: isoFromTs(m && m.timestamp), type: 'other', body: '', mediaId: '', mime: '', caption: '', voice: false, referral: null };
  if (!isObj(m)) return out;
  out.id = s(m.id);
  if (isObj(m.referral)) out.referral = m.referral;
  const t = s(m.type);
  switch (t) {
    case 'text':
      out.type = 'text'; out.body = s(isObj(m.text) ? m.text.body : '');
      break;
    case 'audio': {
      const a = isObj(m.audio) ? m.audio : {};
      out.voice = a.voice === true;
      out.type = out.voice ? 'voice' : 'audio';
      out.mediaId = s(a.id); out.mime = s(a.mime_type);
      break;
    }
    case 'image': case 'video': case 'document': case 'sticker': {
      const x = isObj(m[t]) ? m[t] : {};
      out.type = t; out.mediaId = s(x.id); out.mime = s(x.mime_type);
      out.caption = s(x.caption);
      if (t === 'document' && !out.caption) out.caption = s(x.filename);
      break;
    }
    case 'location': {
      const l = isObj(m.location) ? m.location : {};
      out.type = 'location';
      out.body = [s(l.name), s(l.address), l.latitude != null && l.longitude != null ? `${l.latitude},${l.longitude}` : '']
        .filter(Boolean).join(' · ');
      break;
    }
    case 'button':
      out.type = 'text'; out.body = s(isObj(m.button) ? (m.button.text || m.button.payload) : '');
      break;
    case 'interactive': {
      const i = isObj(m.interactive) ? m.interactive : {};
      const r = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : isObj(i.nfm_reply) ? i.nfm_reply : {};
      out.type = 'text'; out.body = s(r.title || r.body || r.id);
      break;
    }
    case 'reaction':
      out.type = 'reaction'; out.body = s(isObj(m.reaction) ? m.reaction.emoji : '');
      break;
    default:
      out.type = 'other';
      // Some unsupported payloads still carry readable text (e.g. order / system messages).
      out.body = isObj(m.text) ? s(m.text.body) : isObj(m.system) ? s(m.system.body) : '';
  }
  return out;
}

export function parseWebhook(json) {
  const events = [];
  try {
    if (!isObj(json) || !Array.isArray(json.entry)) return events;
    for (const entry of json.entry) {
      if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
      for (const ch of entry.changes) {
        if (!isObj(ch) || !isObj(ch.value)) continue;
        const v = ch.value;
        const meta = isObj(v.metadata) ? v.metadata : {};
        const phoneNumberId = s(meta.phone_number_id);
        const displayPhone = digits(meta.display_phone_number);
        const base = { phoneNumberId, displayPhone };
        const field = s(ch.field);

        if (field === 'messages' || (!field && Array.isArray(v.messages))) {
          const names = {};
          if (Array.isArray(v.contacts)) {
            for (const c of v.contacts) if (isObj(c) && c.wa_id) names[s(c.wa_id)] = s(isObj(c.profile) ? c.profile.name : '');
          }
          if (Array.isArray(v.messages)) {
            for (const m of v.messages) {
              if (!isObj(m) || !m.from) continue;
              const waId = digits(m.from);
              events.push(Object.assign({ kind: 'message', direction: 'in', waId, profileName: names[s(m.from)] || '' }, base, { msg: parseMessage(m) }));
            }
          }
          if (Array.isArray(v.statuses)) {
            for (const st of v.statuses) {
              if (!isObj(st) || !st.id) continue;
              events.push(Object.assign({ kind: 'status', id: s(st.id), status: s(st.status), ts: isoFromTs(st.timestamp) }, base));
            }
          }
        } else if (field === 'smb_message_echoes') {
          const list = Array.isArray(v.message_echoes) ? v.message_echoes : [];
          for (const m of list) {
            if (!isObj(m) || !m.to) continue;
            events.push(Object.assign({ kind: 'echo', direction: 'out', waId: digits(m.to), profileName: '' }, base, { msg: parseMessage(m) }));
          }
        } else if (field === 'history') {
          const chunks = Array.isArray(v.history) ? v.history : [];
          for (const chunk of chunks) {
            if (!isObj(chunk) || !Array.isArray(chunk.threads)) continue;
            for (const th of chunk.threads) {
              if (!isObj(th) || !Array.isArray(th.messages)) continue;
              const waId = digits(th.id);
              for (const m of th.messages) {
                if (!isObj(m)) continue;
                const from = digits(m.from);
                // The business number is the sender of outgoing messages; anything else is the customer.
                const direction = displayPhone && from === displayPhone ? 'out' : 'in';
                const cust = waId || (direction === 'in' ? from : digits(m.to));
                if (!cust) continue;
                events.push(Object.assign({ kind: 'history', direction, waId: cust, profileName: '' }, base, { msg: parseMessage(m) }));
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // Unexpected shape: return whatever was parsed so far.
  }
  return events;
}

// Events pushed by a connector (linked-device / QR bridge) to POST /api/hooks/inbox. Same shape as parseWebhook() output, but the
// business number is identified by `numberPhone` (digits). Anything malformed is dropped; the function never throws.
const MSG_TYPES = ['text', 'voice', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'reaction', 'other'];
export function normalizeInboxEvents(body) {
  const out = [];
  try {
    const list = isObj(body) && Array.isArray(body.events) ? body.events : [];
    for (const e of list.slice(0, 500)) {
      if (!isObj(e)) continue;
      const numberPhone = digits(e.numberPhone);
      if (!numberPhone) continue;
      const base = { phoneNumberId: '', displayPhone: numberPhone };
      if (e.kind === 'status') {
        if (!e.id) continue;
        out.push(Object.assign({ kind: 'status', id: s(e.id), status: s(e.status), ts: isoFromTs(e.ts) }, base));
        continue;
      }
      if (e.kind !== 'message' && e.kind !== 'echo' && e.kind !== 'history') continue;
      const m = isObj(e.msg) ? e.msg : null;
      const waId = digits(e.waId);
      if (!m || !waId) continue;
      const direction = e.kind === 'message' ? 'in' : e.kind === 'echo' ? 'out' : (e.direction === 'out' ? 'out' : 'in');
      const type = MSG_TYPES.includes(m.type) ? m.type : 'other';
      const url = s(m.mediaUrl);
      out.push(Object.assign({ kind: e.kind, direction, waId, profileName: s(e.profileName).slice(0, 200) }, base, {
        msg: {
          id: s(m.id).slice(0, 200), ts: isoFromTs(m.ts), type, body: s(m.body).slice(0, 4096), mediaId: s(m.mediaId).slice(0, 300),
          mediaUrl: /^https?:\/\//i.test(url) ? url.slice(0, 2000) : '', mediaRef: /^[A-Za-z0-9_-]{1,64}$/.test(s(m.mediaRef)) ? s(m.mediaRef) : '', mime: s(m.mime).slice(0, 100), caption: s(m.caption).slice(0, 1024),
          voice: type === 'voice', referral: isObj(m.referral) ? m.referral : null
        }
      }));
    }
  } catch (err) { /* return what was parsed */ }
  return out;
}

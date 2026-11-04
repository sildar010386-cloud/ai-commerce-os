// HTTP client for the CRM connector API. Outbound HTTPS only. JSON, timeout, retries with backoff.

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export class CrmError extends Error {
  constructor(message, status, body) { super(message); this.status = status || 0; this.body = body || ''; }
}
// start of an error answer: it tells why the CRM refused
const bodyOf = async (resp) => { try { return String(await resp.text()).slice(0, 200); } catch (e) { return ''; } };

export function createCrm({ url, token, instanceId = '', fetchImpl = globalThis.fetch, sleep = sleepDefault, timeoutMs = 20000, retries = 3, log = console }) {
  const base = String(url || '').replace(/\/+$/, '');

  async function request(method, path, { body, raw = false, retry = retries } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retry; attempt++) {
      if (attempt) await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(base + path, {
          method,
          headers: Object.assign({ Authorization: `Bearer ${token}` }, instanceId ? { 'X-Connector-Instance': instanceId } : {}, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctl.signal
        });
        if (resp.status === 429 || resp.status >= 500) throw new CrmError('CRM answered ' + resp.status, resp.status, await bodyOf(resp));
        if (!resp.ok) {
          // 4xx: retrying will not help.
          const e = new CrmError('CRM answered ' + resp.status, resp.status, await bodyOf(resp));
          e.final = true;
          throw e;
        }
        if (raw) {
          const buf = Buffer.from(await resp.arrayBuffer());
          return { buffer: buf, mime: resp.headers.get('content-type') || '' };
        }
        return await resp.json().catch(() => ({}));
      } catch (e) {
        lastErr = e instanceof CrmError ? e : new CrmError(e && e.name === 'AbortError' ? 'timeout' : 'network: ' + (e && e.message ? e.message : e), 0);
        if (lastErr.final) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  return {
    request,
    state: (payload) => request('POST', '/api/connector/state', { body: instanceId ? Object.assign({ instance: instanceId }, payload) : payload, retry: 1 }),
    events: (events) => request('POST', '/api/connector/events', { body: { events } }),
    uploadMedia: (mime, buffer) => request('POST', '/api/connector/media', { body: { mime, data: buffer.toString('base64') } }),
    getMedia: (id) => request('GET', '/api/connector/media/' + encodeURIComponent(id), { raw: true }),
    outbox: (ready) => request('GET', '/api/connector/outbox?ready=' + (ready ? 1 : 0) + (instanceId ? '&instance=' + instanceId : ''), { retry: 0 }),
    ack: (payload) => request('POST', '/api/connector/ack', { body: payload })
  };
}

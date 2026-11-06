// Durable queue of events that could not be delivered to the CRM (JSONL file). Order is preserved:
// while the queue is not empty, new events are appended behind it.
// Requests stay small: the CRM runs on a free Cloudflare plan (few D1 queries per request), so history/contact events go
// `historyBatch` at a time and live events `batch` at a time. A request the CRM rejects for good (HTTP 4xx other than 408/429)
// is dropped, otherwise one bad event would block the queue forever.
import fs from 'node:fs';
import path from 'node:path';

// request classes: live messages, history/contact names, lid->phone aliases (each alias may move a whole chat in the CRM: few per request)
const classOf = (e) => (!e ? 'live' : e.kind === 'alias' ? 'alias' : e.kind === 'history' || e.kind === 'contact' || e.kind === 'chat' || e.kind === 'history_result' ? 'bulk' : 'live');
const permanent = (err) => { const s = err && err.status; return s >= 400 && s < 500 && s !== 408 && s !== 429; };

export function createEventQueue({ file, send, log = console, batch = 5, historyBatch = 15, aliasBatch = 6, maxLines = 50000 }) {
  let lines = [];
  let classes = [];   // classOf for every line (parsed once)
  let flushing = false;
  let lastErr = '', lastLogAt = 0, lastLogMsg = '';   // last CRM rejection (status + start of the answer), reported to the CRM in the state posts
  let peak = 0;       // the largest backlog since the queue was last empty (logged when it drains)
  const parse = (l) => { try { return JSON.parse(l); } catch (e) { return null; } };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    classes = lines.map((l) => classOf(parse(l)));
  } catch (e) { log.warn && log.warn('queue load failed: ' + e.message); }

  const persist = () => {
    // tmp + rename: a process killed during the write keeps the previous complete file (a half-written queue loses messages)
    const data = lines.length ? lines.join('\n') + '\n' : '';
    try { fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file); }
    catch (e) {
      try { fs.writeFileSync(file, data); } catch (e2) { log.warn && log.warn('queue write failed: ' + e2.message); }
    }
  };
  const append = (events) => {
    for (const e of events) { lines.push(JSON.stringify(e)); classes.push(classOf(e)); }
    if (lines.length > maxLines) { lines = lines.slice(lines.length - maxLines); classes = classes.slice(classes.length - maxLines); }
    if (lines.length > peak) peak = lines.length;
    persist();
  };

  // The next request. Live events (a client writing now) go first, even when thousands of history events are waiting
  // (a new QR pairing queues ~15000 of them, several minutes of requests): a new client must reach the CRM at once.
  // Otherwise lines from the head while they are of the same class, at most the class limit.
  function nextChunk() {
    if (classes[0] !== 'live') {
      const idx = [];
      for (let i = 0; i < classes.length && idx.length < batch; i++) if (classes[i] === 'live') idx.push(i);
      if (idx.length) return { idx, events: idx.map((i) => parse(lines[i])).filter(Boolean) };
    }
    const cls = classes[0];
    const limit = cls === 'alias' ? aliasBatch : cls === 'bulk' ? historyBatch : batch;
    let n = 1;
    while (n < lines.length && n < limit && classes[n] === cls) n++;
    const idx = Array.from({ length: n }, (_, i) => i);
    return { idx, events: lines.slice(0, n).map(parse).filter(Boolean) };
  }
  const drop = (idx) => {
    const gone = new Set(idx);
    lines = lines.filter((_, i) => !gone.has(i));
    classes = classes.filter((_, i) => !gone.has(i));
  };

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (lines.length) {
        const { idx, events } = nextChunk();
        try { if (events.length) await send(events); lastErr = ''; }
        catch (e) {
          // every rejection is logged with the status and the start of the CRM's answer (it says why), and kept for the CRM's diagnostics
          const kinds = {};
          for (const ev of events) kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
          const what = Object.entries(kinds).map(([k, v]) => k + ' x' + v).join(', ');
          const why = `${e && e.status ? e.status : 'no answer'} ${String((e && e.body) || (e && e.message) || '').replace(/\s+/g, ' ').slice(0, 200)}`.trim();
          lastErr = `${permanent(e) ? 'dropped' : 'retry'} [${what}] ${why}`.slice(0, 300);
          const nowMs = Date.now();
          if (permanent(e) || lastErr !== lastLogMsg || nowMs - lastLogAt > 60000) {
            log.warn && log.warn(permanent(e) ? `dropping ${events.length} events the CRM rejected (${what}): ${why}` : `CRM did not accept ${events.length} events (${what}), will retry: ${why}`);
            lastLogMsg = lastErr; lastLogAt = nowMs;
          }
          if (!permanent(e)) throw e;
        }
        drop(idx);
        persist();
      }
      if (peak >= 200) log.info && log.info(`queue: all events delivered to the CRM (backlog was ${peak})`);
      peak = 0;
    } catch (e) {
      // CRM unreachable: keep everything, try again on the next flush.
    } finally { flushing = false; }
  }

  async function push(events) {
    if (!events.length) return;
    if (lines.length || flushing) { append(events); return flush(); }
    // Fresh events are cut into the same small requests as the persisted ones.
    append(events);
    return flush();
  }

  return { push, flush, size: () => lines.length, lastError: () => lastErr };
}

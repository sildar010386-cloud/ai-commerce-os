// Durable queue of events that could not be delivered to the CRM (JSONL file). Order is preserved:
// while the queue is not empty, new events are appended behind it.
// Requests stay small: the CRM runs on a free Cloudflare plan (few D1 queries per request), so history/contact events go
// `historyBatch` at a time and live events `batch` at a time. A request the CRM rejects for good (HTTP 4xx other than 408/429)
// is dropped, otherwise one bad event would block the queue forever.
import fs from 'node:fs';
import path from 'node:path';

const isBulk = (e) => !!e && (e.kind === 'history' || e.kind === 'contact');
const permanent = (err) => { const s = err && err.status; return s >= 400 && s < 500 && s !== 408 && s !== 429; };

export function createEventQueue({ file, send, log = console, batch = 5, historyBatch = 15, maxLines = 50000 }) {
  let lines = [];
  let flushing = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (e) { log.warn && log.warn('queue load failed: ' + e.message); }

  const persist = () => {
    try { fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : ''); } catch (e) { log.warn && log.warn('queue write failed: ' + e.message); }
  };
  const append = (events) => {
    for (const e of events) lines.push(JSON.stringify(e));
    if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
    persist();
  };
  const parse = (l) => { try { return JSON.parse(l); } catch (e) { return null; } };

  // Takes lines from the head while they are of the same class (bulk or live), at most the class limit.
  function nextChunk() {
    const first = parse(lines[0]);
    const bulk = isBulk(first), limit = bulk ? historyBatch : batch;
    let n = 1;
    while (n < lines.length && n < limit && isBulk(parse(lines[n])) === bulk) n++;
    return { n, events: lines.slice(0, n).map(parse).filter(Boolean) };
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (lines.length) {
        const { n, events } = nextChunk();
        try { if (events.length) await send(events); }
        catch (e) {
          if (!permanent(e)) throw e;
          log.warn && log.warn(`dropping ${events.length} events the CRM rejected: ${e.message}`);
        }
        lines = lines.slice(n);
        persist();
      }
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

  return { push, flush, size: () => lines.length };
}

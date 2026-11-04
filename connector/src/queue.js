// Durable queue of events that could not be delivered to the CRM (JSONL file). Order is preserved:
// while the queue is not empty, new events are appended behind it.
import fs from 'node:fs';
import path from 'node:path';

export function createEventQueue({ file, send, log = console, batch = 100, maxLines = 20000 }) {
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

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (lines.length) {
        const chunk = lines.slice(0, batch).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        const n = Math.min(batch, lines.length);
        if (chunk.length) await send(chunk);
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
    try { await send(events); }
    catch (e) { append(events); }
  }

  return { push, flush, size: () => lines.length };
}

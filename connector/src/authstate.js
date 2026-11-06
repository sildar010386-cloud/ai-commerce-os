// The WhatsApp session on disk (creds + signal keys, one JSON file each), like Baileys' useMultiFileAuthState, with two changes:
//  1. every file is written to a temporary file and renamed over the old one, so a process killed in the middle of a write
//     (laptop shutdown, a forced stop) leaves the previous complete file, never a half-written one. A broken key file makes
//     WhatsApp messages from that chat undecryptable; a broken creds.json loses the whole session.
//  2. flush() waits for the writes that are still running, so a planned stop does not cut them off.
import fsp from 'node:fs/promises';
import path from 'node:path';

const fixFileName = (file) => String(file || '').replace(/\//g, '__').replace(/:/g, '-');

// Atomic write: tmp + rename. On Windows a rename can fail for a moment when another program (an antivirus) holds the target:
// a few retries, then a plain write as the last resort (still better than losing the data).
export async function writeFileAtomic(file, data, { fs = fsp, retries = 3, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try { await fs.rename(tmp, file); return; }
    catch (e) {
      if (i >= retries) { await fs.writeFile(file, data); try { await fs.unlink(tmp); } catch (e2) { /* gone */ } return; }
      await wait(50 * (i + 1));
    }
  }
}

export async function useDurableAuthState(folder, { BufferJSON, initAuthCreds, proto, fs = fsp } = {}) {
  await fs.mkdir(folder, { recursive: true });
  // leftovers of writes that were cut off: the real files are intact, the temporary copies are useless
  try { for (const f of await fs.readdir(folder)) if (f.endsWith('.tmp')) await fs.unlink(path.join(folder, f)).catch(() => {}); } catch (e) { /* ignore */ }

  const chains = new Map();          // file -> the last operation on it (operations on one file run one after another)
  const pending = new Set();
  const onFile = (file, op) => {
    const prev = chains.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(op);
    chains.set(file, next);
    pending.add(next);
    next.finally(() => { pending.delete(next); if (chains.get(file) === next) chains.delete(file); }).catch(() => {});
    return next;
  };
  const full = (file) => path.join(folder, fixFileName(file));
  const writeData = (data, file) => onFile(full(file), () => writeFileAtomic(full(file), JSON.stringify(data, BufferJSON.replacer), { fs }));
  const readData = async (file) => {
    try {
      const text = await onFile(full(file), () => fs.readFile(full(file), { encoding: 'utf-8' }));
      return JSON.parse(text, BufferJSON.reviver);
    } catch (e) { return null; }
  };
  const removeData = (file) => onFile(full(file), () => fs.unlink(full(file)).catch(() => {}));

  const creds = (await readData('creds.json')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value && proto) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds.json'),
    // waits (at most `ms`) for every write still running
    flush: async (ms = 3000) => {
      const all = Promise.allSettled([...pending]);
      await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
    }
  };
}

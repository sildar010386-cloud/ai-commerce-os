// Traffic-source detection for the first message of a new client: ad ("target") or organic.
// Pure functions, no I/O. Used by worker.js and unit-tested with `node --test`.

// Lower-case, ё -> е, drop punctuation / emoji, collapse spaces.
export function normalizeText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A code of an active target written as "(A3)", "#A3" or "код A3" (any case).
export function findCode(text, targets) {
  const t = String(text == null ? '' : text);
  if (!t) return null;
  let best = null;
  for (const tg of targets || []) {
    if (!tg || !tg.active || !tg.code) continue;
    const c = escapeRe(String(tg.code).trim());
    if (!c) continue;
    const end = '(?![\\p{L}\\p{N}])';
    const re = new RegExp(`(?:\\(\\s*${c}\\s*\\)|#${c}${end}|(?<![\\p{L}\\p{N}])код\\s*:?\\s*${c}${end})`, 'iu');
    if (re.test(t) && (!best || String(tg.code).length > String(best.code).length)) best = tg;
  }
  return best;
}

// Best target whose text is contained in the message, or shares >= 80% of its words with it.
export function findByText(text, targets) {
  const msg = normalizeText(text);
  if (!msg) return null;
  const msgWords = new Set(msg.split(' '));
  let best = null, bestScore = 0, bestLen = 0;
  for (const tg of targets || []) {
    if (!tg || !tg.active) continue;
    const tt = normalizeText(tg.text);
    if (tt.length < 4) continue;
    let score = 0;
    if ((' ' + msg + ' ').includes(' ' + tt + ' ')) score = 1;
    else {
      const words = tt.split(' ');
      if (words.length >= 3) {
        const hit = words.filter((w) => msgWords.has(w)).length;
        const ratio = hit / words.length;
        if (ratio >= 0.8) score = ratio;
      }
    }
    if (score > 0 && (score > bestScore || (score === bestScore && tt.length > bestLen))) {
      best = tg; bestScore = score; bestLen = tt.length;
    }
  }
  return best;
}

function platformFromUrl(url) {
  const u = String(url == null ? '' : url).toLowerCase();
  if (/instagram\.com|instagr\.am/.test(u)) return 'Instagram';
  if (/facebook\.com|fb\.com|fb\.me|fb\.watch|\bfb\b/.test(u)) return 'Facebook';
  return '';
}

function result(traffic, platform, tg) {
  return { traffic, platform: platform || '', code: tg ? String(tg.code) : '', product: tg ? String(tg.product_name || '') : '' };
}

export function detectSource({ text, referral, targets } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const ref = referral && typeof referral === 'object' ? referral : null;
  const refPlatform = ref ? platformFromUrl(ref.source_url) : '';

  // (a) explicit code, (b) the pre-filled text
  const hit = findCode(text, list) || findByText(text, list);
  if (hit) return result('target', refPlatform, hit);

  // (c) click-to-WhatsApp ad referral
  if (ref && String(ref.source_type || '').toLowerCase() === 'ad') {
    const adText = [ref.headline, ref.body].filter(Boolean).join(' ');
    const adHit = adText ? (findCode(adText, list) || findByText(adText, list)) : null;
    return result('target', refPlatform || 'Instagram', adHit);
  }

  // (d) everything else
  return result('organic', refPlatform, null);
}

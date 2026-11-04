// USD -> KZT exchange rates: parsers for the National Bank of Kazakhstan RSS and open.er-api.com, plus the fetchers.
// Pure parsing + fetch with a timeout; the Worker (worker.js) decides which rate to use and stores it. Failures return null, never throw.

export const NBK_URL = 'https://nationalbank.kz/rss/get_rates.cfm?fdate=';
export const ERAPI_URL = 'https://open.er-api.com/v6/latest/USD';
export const FX_TIMEOUT_MS = 5000;

const num = (s) => {
  const n = parseFloat(String(s == null ? '' : s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const unCdata = (s) => String(s == null ? '' : s).replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
// Text of the first <tag>...</tag> inside `xml` ('' when absent).
const tagText = (xml, tag) => {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i').exec(xml);
  return m ? unCdata(m[1]) : '';
};

// NBK get_rates.cfm answer: <rates><item><fullname>..</fullname><title>USD</title><description>470.94</description><quant>1</quant>..</item>...</rates>.
// Returns KZT per 1 USD (description / quant) or null.
export function parseNbkUsd(xml) {
  const text = String(xml == null ? '' : xml);
  const items = text.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
  for (const it of items) {
    if (tagText(it, 'title').toUpperCase() !== 'USD') continue;
    const value = num(tagText(it, 'description'));
    let quant = num(tagText(it, 'quant'));
    if (!(quant > 0)) quant = 1;
    const rate = value / quant;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  return null;
}

// open.er-api.com/v6/latest/USD answer: {"result":"success","rates":{"KZT":512.3,...}}.
export function parseErApiUsd(data) {
  let d = data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return null; } }
  if (!d || typeof d !== 'object') return null;
  if (d.result && d.result !== 'success') return null;
  const v = d.rates && typeof d.rates === 'object' ? Number(d.rates.KZT) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function getText(fetchFn, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FX_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': 'bikas-crm' } });
    if (!r || !r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// date = 'YYYY-MM-DD' (Almaty day) -> NBK wants DD.MM.YYYY.
export async function fetchNbkUsd(date, fetchFn = fetch) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return null;
  const body = await getText(fetchFn, NBK_URL + `${m[3]}.${m[2]}.${m[1]}`);
  return body == null ? null : parseNbkUsd(body);
}
export async function fetchErApiUsd(fetchFn = fetch) {
  const body = await getText(fetchFn, ERAPI_URL);
  return body == null ? null : parseErApiUsd(body);
}

// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Minimal WooCommerce REST client for the ledger. Reads everything from env — never hardcoded
// URLs or keys (see each shop's CLAUDE.md):
//   WOOCOMMERCE_STORE_URL        e.g. https://admin.skarpekniver.com
//   WOOCOMMERCE_CONSUMER_KEY / WOOCOMMERCE_CONSUMER_SECRET
// Aliases, used when the WOOCOMMERCE_* names are unset (same as backend-handel/lib/woo.js):
//   WC_API_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET
// Retries 429/5xx/network errors with exponential backoff.

const TIMEOUT_MS = Number(process.env.INVENTORY_WOO_TIMEOUT_MS || 20000);

function firstSet(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function wooCredentials() {
  // WC_API_URL is a store URL, same as WOOCOMMERCE_STORE_URL. Strip a trailing REST path if present.
  const url = firstSet('WOOCOMMERCE_STORE_URL', 'WC_API_URL').replace(/\/$/, '').replace(/\/wp-json\/wc\/v3$/, '');
  return {
    url,
    key: firstSet('WOOCOMMERCE_CONSUMER_KEY', 'WC_CONSUMER_KEY'),
    secret: firstSet('WOOCOMMERCE_CONSUMER_SECRET', 'WC_CONSUMER_SECRET'),
  };
}

function base() {
  return wooCredentials().url;
}

export function wooConfigured() {
  const c = wooCredentials();
  return Boolean(c.url && c.key && c.secret);
}

export class WooError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'WooError';
    this.status = status;
    this.body = body;
  }
}

function url(path, params = {}) {
  const c = wooCredentials();
  const u = new URL(`${c.url}/wp-json/wc/v3${path}`);
  u.searchParams.set('consumer_key', c.key);
  u.searchParams.set('consumer_secret', c.secret);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function wooRequest(method, path, { params, body, retries = 3 } = {}) {
  if (!wooConfigured()) throw new WooError(0, 'WooCommerce is not configured (WOOCOMMERCE_* or WC_* env)');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url(path, params), {
        method,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
      if (res.ok) return { data: json, headers: res.headers };
      lastErr = new WooError(res.status, `Woo ${method} ${path} → ${res.status}: ${json?.message || res.statusText}`, json);
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (err) {
      if (err instanceof WooError && err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = err instanceof WooError ? err : new WooError(0, `Woo ${method} ${path} failed: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}

export const wooGet = (path, params) => wooRequest('GET', path, { params }).then((r) => r.data);
export const wooPost = (path, body) => wooRequest('POST', path, { body }).then((r) => r.data);

/** Fetch every page (per_page 100). */
export async function wooGetAll(path, params = {}, { maxPages = 200 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await wooRequest('GET', path, { params: { per_page: 100, ...params, page } });
    const arr = Array.isArray(data) ? data : [];
    out.push(...arr);
    const totalPages = Number(headers.get('x-wp-totalpages') || 0);
    if (arr.length < 100 || (totalPages && page >= totalPages)) break;
  }
  return out;
}

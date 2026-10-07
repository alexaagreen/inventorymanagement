// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Minimal WooCommerce REST-klient for ledgeren. Leser alt fra env — aldri hardkodede
// URL-er eller nøkler (se butikkenes CLAUDE.md):
//   WOOCOMMERCE_STORE_URL        f.eks. https://admin.skarpekniver.com
//   WOOCOMMERCE_CONSUMER_KEY / WOOCOMMERCE_CONSUMER_SECRET
// Retry på 429/5xx/nettverksfeil med eksponentiell backoff.

const TIMEOUT_MS = Number(process.env.INVENTORY_WOO_TIMEOUT_MS || 20000);

function base() {
  return (process.env.WOOCOMMERCE_STORE_URL || '').replace(/\/$/, '');
}

export function wooConfigured() {
  return Boolean(base() && process.env.WOOCOMMERCE_CONSUMER_KEY && process.env.WOOCOMMERCE_CONSUMER_SECRET);
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
  const u = new URL(`${base()}/wp-json/wc/v3${path}`);
  u.searchParams.set('consumer_key', process.env.WOOCOMMERCE_CONSUMER_KEY || '');
  u.searchParams.set('consumer_secret', process.env.WOOCOMMERCE_CONSUMER_SECRET || '');
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function wooRequest(method, path, { params, body, retries = 3 } = {}) {
  if (!wooConfigured()) throw new WooError(0, 'WooCommerce is not configured (WOOCOMMERCE_* env)');
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

/** Hent alle sider (per_page 100). `onPage` kan brukes for strømming. */
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

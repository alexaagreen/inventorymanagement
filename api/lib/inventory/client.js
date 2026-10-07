// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Klient-helper for UI (kun fetch — trygg i React, ingen server-importer).
//   const { data, next_cursor } = await inv('/movements?sku=KNIV-1&type=sale');
//   await inv('/adjustments', { method: 'POST', body: {...}, idempotencyKey: newIdempotencyKey() });
// Feil kastes som Error med { code, details, status }; bruk userMessage(err) fra ./errors for tekst.

const BASE = '/api/inventory';

export function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function inv(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    throw Object.assign(new Error(e.message || res.statusText), { code: e.code || 'HTTP_' + res.status, details: e.details || {}, status: res.status });
  }
  return json;
}

/** Bygg querystring og dropp tomme verdier: qs({ sku: 'A', type: ['sale','sale_return'] }) */
export function qs(params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

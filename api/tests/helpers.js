import { query } from '../lib/inventory/db';

export const API_KEY = 'test-key';
process.env.INVENTORY_API_KEY = API_KEY;

/** Kall en Next API-handler med en minimal req/res. */
export async function call(handler, { method = 'GET', query: q = {}, body, headers = {}, auth = true } = {}) {
  const req = {
    method,
    query: q,
    body,
    url: '/api/inventory/test',
    headers: { ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}), ...lower(headers) },
  };
  const res = {
    statusCode: 200, headers: {}, body: undefined, headersSent: false, writableEnded: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; this.writableEnded = true; return this; },
    send(b) { this.body = b; this.headersSent = true; this.writableEnded = true; return this; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

function lower(h) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export async function item(sku, woo = null, variation = null) {
  await query(`select inv.upsert_item($1::jsonb)`, [JSON.stringify({ sku, name: sku, woo_product_id: woo, woo_variation_id: variation })]);
}

export async function db(text, params) {
  return (await query(text, params)).rows;
}

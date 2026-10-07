// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Woo → ledger: webhook-verifisering (HMAC), ordre/refusjon inn i inv.apply_woo_order /
// inv.apply_woo_refund, og backfill av ordrer fra Woo REST.
import crypto from 'node:crypto';
import { rpc, sql } from './rpc';
import { wooGet, wooRequest } from './woo';
import { kickPush } from './woo-push';

export function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Fail-closed: uten WC_WEBHOOK_SECRET avvises alt. */
export function verifyWooSignature(rawBody, signature, secret = process.env.WC_WEBHOOK_SECRET || '') {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(String(signature).trim());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isWooPing(rawBody) {
  return /^webhook_id=\d+/.test(rawBody.toString('utf8'));
}

async function processedRefunds(orderId) {
  const [row] = await sql(`select refunds from inv.woo_order_sync where woo_order_id = $1`, [orderId]);
  return new Set((row?.refunds || []).map(String));
}

/** Kjør en ordre gjennom ledgeren, inkl. nye refusjoner (hentes fra Woo REST). */
export async function applyOrder(order, source = 'webhook') {
  const result = await rpc('apply_woo_order', [order, source]);
  const refunds = [];
  const ids = (order.refunds || []).map((r) => String(r.id)).filter(Boolean);
  if (ids.length) {
    const done = await processedRefunds(order.id);
    for (const rid of ids.filter((id) => !done.has(id))) {
      const refund = await wooGet(`/orders/${order.id}/refunds/${rid}`);
      refunds.push(await rpc('apply_woo_refund', [order.id, refund]));
    }
  }
  return { ...result, refunds };
}

/**
 * Webhook-handler for order.created / order.updated / order.deleted.
 * Returnerer { status, body } — routen sender det.
 */
export async function handleOrderWebhook(rawBody, headers) {
  const topic = headers['x-wc-webhook-topic'] || null;
  if (!verifyWooSignature(rawBody, headers['x-wc-webhook-signature'])) {
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'invalid webhook signature', details: {} } } };
  }
  if (isWooPing(rawBody)) return { status: 200, body: { ping: true } };

  let order;
  try { order = JSON.parse(rawBody.toString('utf8')); } catch {
    await rpc('log_woo_webhook', [topic, null, 'error', 'invalid JSON']);
    return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid JSON', details: {} } } };
  }
  if (!order?.id) {
    await rpc('log_woo_webhook', [topic, null, 'ignored', 'no order id']);
    return { status: 200, body: { action: 'ignored' } };
  }
  if (topic === 'order.deleted') {
    await rpc('log_woo_webhook', [topic, String(order.id), 'ignored', null]);
    return { status: 200, body: { action: 'ignored' } };
  }

  try {
    const r = await applyOrder(order, 'webhook');
    const moved = r.movements.length + r.refunds.reduce((s, x) => s + (x.movements?.length || 0), 0);
    await rpc('log_woo_webhook', [topic, String(order.id), moved ? 'applied' : 'ignored',
      r.unmatched_skus?.length ? `unmatched: ${r.unmatched_skus.map((u) => u.sku || u.product_id).join(', ')}` : null]);
    if (moved) kickPush();
    return { status: 200, body: { action: r.action, movements: moved, unmatched_skus: r.unmatched_skus, refunds: r.refunds.length } };
  } catch (err) {
    await rpc('log_woo_webhook', [topic, String(order.id), 'error', err.message]).catch(() => {});
    // 500 → Woo prøver igjen med backoff
    return { status: 500, body: { error: { code: err.code || 'INTERNAL', message: err.message, details: err.details || {} } } };
  }
}

/**
 * Backfill: hent ordrer endret i [from, to) og kjør dem gjennom ledgeren (idempotent).
 * Tidsbudsjett så kallet holder seg innenfor serverless-grensen; returnerer next_page.
 */
export async function importOrders({ from, to, page = 1, budgetMs = 50000 } = {}) {
  const started = Date.now();
  let processed = 0; let movements = 0; let p = page; const errors = [];
  for (;;) {
    const { data, headers } = await wooRequest('GET', '/orders', {
      params: { per_page: 100, page: p, status: 'any', orderby: 'id', order: 'asc',
        ...(from ? { modified_after: from } : {}), ...(to ? { modified_before: to } : {}), dates_are_gmt: true },
    });
    const orders = Array.isArray(data) ? data : [];
    for (const o of orders) {
      try {
        const r = await applyOrder(o, 'backfill');
        movements += r.movements.length + r.refunds.reduce((s, x) => s + (x.movements?.length || 0), 0);
      } catch (err) {
        errors.push({ order_id: o.id, message: err.message });
      }
      processed++;
    }
    const totalPages = Number(headers.get('x-wp-totalpages') || 0);
    const done = orders.length < 100 || (totalPages && p >= totalPages);
    if (done) { if (movements) kickPush(); return { processed, movements, errors, next_page: null }; }
    p++;
    if (Date.now() - started > budgetMs) { if (movements) kickPush(); return { processed, movements, errors, next_page: p }; }
  }
}

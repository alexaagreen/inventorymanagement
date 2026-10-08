// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { readRawBody, handleOrderWebhook } from '../../../../lib/inventory/woo-order';

// POST /api/inventory/webhooks/woo-order
// WooCommerce → Settings → Advanced → Webhooks: topics order.created + order.updated (+ order.deleted)
// Secret = WC_WEBHOOK_SECRET. HMAC verified, fail-closed. Allowlist this path in middleware.js.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only', details: {} } });
  }
  const raw = await readRawBody(req);
  const out = await handleOrderWebhook(raw, req.headers || {});
  return res.status(out.status).json(out.body);
}

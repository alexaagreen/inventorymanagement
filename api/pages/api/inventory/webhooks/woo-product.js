// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { readRawBody, verifyWooSignature, isWooPing } from '../../../../lib/inventory/woo-order';
import { upsertWooProduct, deactivateWooProduct } from '../../../../lib/inventory/woo-push';
import { rpc } from '../../../../lib/inventory/rpc';

// POST /api/inventory/webhooks/woo-product — topics product.created / product.updated / product.deleted
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only', details: {} } });
  }
  const raw = await readRawBody(req);
  const headers = req.headers || {};
  const topic = headers['x-wc-webhook-topic'] || null;
  if (!verifyWooSignature(raw, headers['x-wc-webhook-signature'])) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'invalid webhook signature', details: {} } });
  }
  if (isWooPing(raw)) return res.status(200).json({ ping: true });
  let p;
  try { p = JSON.parse(raw.toString('utf8')); } catch {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'invalid JSON', details: {} } });
  }
  try {
    // Variation webhooks (product.updated for one variation) set parent_id
    if (p?.parent_id) {
      const { wooGet } = await import('../../../../lib/inventory/woo');
      p = await wooGet(`/products/${p.parent_id}`);
    }
    const out = topic === 'product.deleted' ? await deactivateWooProduct(p.id) : await upsertWooProduct(p);
    await rpc('log_woo_webhook', [topic, String(p.id), 'applied', null]);
    return res.status(200).json(out);
  } catch (err) {
    await rpc('log_woo_webhook', [topic, String(p?.id ?? ''), 'error', err.message]).catch(() => {});
    return res.status(500).json({ error: { code: err.code || 'INTERNAL', message: err.message, details: {} } });
  }
}

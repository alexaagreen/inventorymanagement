// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// requireInventoryAuth(req, res) → { by, via } eller null (og 401 er sendt).
// Godtar:
//   Authorization: Bearer $INVENTORY_API_KEY   (agenter, cron, server-til-server)
//   innlogget session via config.getSessionUser (UI)
// Webhook-ruter bruker HMAC i stedet (woo-webhook.js).
import crypto from 'node:crypto';
import { getSessionUser } from './config';
import { InventoryError } from './errors';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Kaster InventoryError('UNAUTHORIZED') hvis ingen gyldig auth. */
export async function authenticate(req, res) {
  const keys = String(process.env.INVENTORY_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const token = bearer(req);
  if (token && keys.length && keys.some((k) => safeEqual(token, k))) {
    // Agenter kan attribuere med body.by / x-inventory-by
    const by = req.headers?.['x-inventory-by'] || req.body?.by || 'api-key';
    return { by: String(by).slice(0, 200), via: 'api-key' };
  }
  const user = await getSessionUser(req, res);
  if (user) return { by: String(user), via: 'session' };
  throw new InventoryError('UNAUTHORIZED', 'Missing or invalid credentials');
}

export async function requireInventoryAuth(req, res) {
  try {
    return await authenticate(req, res);
  } catch (err) {
    res.status(401).json(err.toJSON());
    return null;
  }
}

// SHOP-SPECIFIC — scripts/install.mjs copies this to lib/inventory/config.js ONCE
// (only when config.js is missing). After that the shop repo owns the file and it is never overwritten.
//
// getSessionUser(req, res) → email/name of the signed-in user, or null (→ 401).
// Pick the variant that matches how the shop's internal-web does auth.
//
// assertCron(req, res) is optional. Shops without assertCronAuth plug their own check in here
// and call it from the cron wrappers:
//   import { assertCron } from '@/lib/inventory/config';
//   if (typeof assertCron === 'function' && !(await assertCron(req, res))) return;
// Return true to allow the request. Return false after sending the response to reject it.
// Replace the function entirely to delegate to the portal's own helper (for example requireSecretOrSession).

import crypto from 'node:crypto';
// ── Variant A: NextAuth v4 with the JWT strategy (bark-internal-web) ─────────
import { getToken } from 'next-auth/jwt';

export async function getSessionUser(req /* , res */) {
  try {
    const token = await getToken({ req });
    if (token?.email) return token.email;
  } catch (err) {
    console.warn('[inventory/config] getToken failed:', err?.message || err);
  }
  // Local development only: INVENTORY_ALLOW_OPEN=true lets the UI through without a session.
  // Always ignored in production — auth must be on there.
  if (process.env.INVENTORY_ALLOW_OPEN === 'true' && process.env.NODE_ENV !== 'production') {
    return 'dev (auth off)';
  }
  return null;
}

// ── Variant B: NextAuth v4 with getServerSession (Skarpekniver internal-web) ──
// import { getServerSession } from 'next-auth/next';
// import { authOptions } from '../../pages/api/auth/[...nextauth]';
// export async function getSessionUser(req, res) {
//   const s = await getServerSession(req, res, authOptions);
//   return s?.user?.email || null;
// }

/**
 * Optional cron gate. Accepts Vercel's `Authorization: Bearer $CRON_SECRET`,
 * otherwise the same session as the UI. Sends 401 and returns false when neither matches.
 */
export async function assertCron(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match ? match[1].trim() : '';
  if (secret && token && token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
    return true;
  }
  const user = await getSessionUser(req, res);
  if (user) return true;
  if (!res.headersSent) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', details: {} } });
  }
  return false;
}

export const inventoryConfig = {
  defaultLocation: null,   // null = the location flagged is_default in inv.location
  slackChannel: null,      // e.g. '#stock'
  wooPush: true,           // push available → Woo stock_quantity (also gated by inv.settings.woo_push_enabled)
};

// SHOP-SPECIFIC — this file is NOT overwritten by scripts/install.mjs.
// Adapt per shop. The defaults below are for this module repo's own test app.
//
// getSessionUser(req, res): return the email/name of the signed-in user, or null.
// Example internal-web / bark-internal-web (NextAuth v4):
//
//   import { getServerSession } from 'next-auth/next';
//   import { authOptions } from '../../pages/api/auth/[...nextauth]';
//   export async function getSessionUser(req, res) {
//     const s = await getServerSession(req, res, authOptions);
//     return s?.user?.email || null;
//   }
//
// assertCron is optional. See config.example.js. The test app accepts Bearer CRON_SECRET
// and otherwise rejects, because getSessionUser returns null.

import crypto from 'node:crypto';

export const inventoryConfig = {
  defaultLocation: null,          // null = the location flagged is_default in inv.location
  slackChannel: null,             // e.g. '#stock' (alerts from reconcile / open consumption)
  wooPush: true,                  // push available → Woo stock_quantity
};

export async function getSessionUser(/* req, res */) {
  return null;
}

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

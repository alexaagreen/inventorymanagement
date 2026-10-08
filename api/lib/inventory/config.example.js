// SHOP-SPECIFIC — scripts/install.mjs copies this to lib/inventory/config.js ONCE
// (only if config.js is missing). After that the file is owned by the shop repo and never overwritten.
//
// getSessionUser(req, res) → email/name of the logged-in user, or null (→ 401).
// Pick the variant matching how the shop's internal-web does auth.

// ── Variant A: NextAuth v4 with JWT strategy (bark-internal-web) ────────────
import { getToken } from 'next-auth/jwt';

export async function getSessionUser(req /* , res */) {
  try {
    const token = await getToken({ req });
    if (token?.email) return token.email;
  } catch (err) {
    console.warn('[inventory/config] getToken failed:', err?.message || err);
  }
  // Local development only: INVENTORY_ALLOW_OPEN=true lets the UI through without login.
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

export const inventoryConfig = {
  defaultLocation: null,   // null = the location marked is_default in inv.location
  slackChannel: null,      // e.g. '#lager'
  wooPush: true,           // push available → Woo stock_quantity (also gated by inv.settings.woo_push_enabled)
};

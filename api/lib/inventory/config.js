// SHOP-SPECIFIC — this file is NOT overwritten by scripts/install.mjs.
// Customize per shop. The defaults below apply to the module repo's own test app.
//
// getSessionUser(req, res): return email/name of the logged-in user, or null.
// Example internal-web / bark-internal-web (NextAuth v4):
//
//   import { getServerSession } from 'next-auth/next';
//   import { authOptions } from '../../pages/api/auth/[...nextauth]';
//   export async function getSessionUser(req, res) {
//     const s = await getServerSession(req, res, authOptions);
//     return s?.user?.email || null;
//   }

export const inventoryConfig = {
  defaultLocation: null,          // null = the location marked is_default in inv.location
  slackChannel: null,             // e.g. '#lager' (alerts from reconcile/open consumption)
  wooPush: true,                  // push available → Woo stock_quantity
};

export async function getSessionUser(/* req, res */) {
  return null;
}

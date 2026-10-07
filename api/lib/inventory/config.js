// SHOP-SPECIFIC — this file is NOT overwritten by scripts/install.mjs.
// Tilpass per butikk. Defaultene under gjelder modul-repoets egen test-app.
//
// getSessionUser(req, res): returner e-post/navn for innlogget bruker, eller null.
// Eksempel internal-web / bark-internal-web (NextAuth v4):
//
//   import { getServerSession } from 'next-auth/next';
//   import { authOptions } from '../../pages/api/auth/[...nextauth]';
//   export async function getSessionUser(req, res) {
//     const s = await getServerSession(req, res, authOptions);
//     return s?.user?.email || null;
//   }

export const inventoryConfig = {
  defaultLocation: null,          // null = lokasjonen merket is_default i inv.location
  slackChannel: null,             // f.eks. '#lager' (varsler fra reconcile/åpent konsum)
  wooPush: true,                  // push available → Woo stock_quantity
};

export async function getSessionUser(/* req, res */) {
  return null;
}

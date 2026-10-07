// SHOP-SPECIFIC — scripts/install.mjs kopierer denne til lib/inventory/config.js ÉN gang
// (bare hvis config.js mangler). Etter det eies filen av butikk-repoet og overskrives aldri.
//
// getSessionUser(req, res) → e-post/navn for innlogget bruker, eller null (→ 401).
// Velg variant etter hvordan butikkens internal-web gjør auth.

// ── Variant A: NextAuth v4 med JWT-strategi (bark-internal-web) ─────────────
import { getToken } from 'next-auth/jwt';

export async function getSessionUser(req /* , res */) {
  try {
    const token = await getToken({ req });
    if (token?.email) return token.email;
  } catch (err) {
    console.warn('[inventory/config] getToken failed:', err?.message || err);
  }
  // Kun lokal utvikling: INVENTORY_ALLOW_OPEN=true slipper UI-et gjennom uten innlogging.
  // Ignoreres alltid i produksjon — der må auth være på.
  if (process.env.INVENTORY_ALLOW_OPEN === 'true' && process.env.NODE_ENV !== 'production') {
    return 'dev (auth off)';
  }
  return null;
}

// ── Variant B: NextAuth v4 med getServerSession (Skarpekniver internal-web) ──
// import { getServerSession } from 'next-auth/next';
// import { authOptions } from '../../pages/api/auth/[...nextauth]';
// export async function getSessionUser(req, res) {
//   const s = await getServerSession(req, res, authOptions);
//   return s?.user?.email || null;
// }

export const inventoryConfig = {
  defaultLocation: null,   // null = lokasjonen merket is_default i inv.location
  slackChannel: null,      // f.eks. '#lager'
  wooPush: true,           // push available → Woo stock_quantity (styres i tillegg av inv.settings.woo_push_enabled)
};

// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// GET /api/inventory/sync/integrity → { ok, issues[] } (inv.verify_integrity)
export default route({ GET: async () => rpc('verify_integrity', []) });

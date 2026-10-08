// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../../lib/inventory/handler';
import { syncItems } from '../../../../lib/inventory/woo-push';

// POST /api/inventory/items/sync?source=auto|catalog|woo — product master → inv.item
export default route({
  POST: async (req, res, { query }) => withStatus(200, await syncItems({ source: query.source || 'auto' })),
}, { noPush: true });

// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit } from '../../../../lib/inventory/handler';
import { webhookLog } from '../../../../lib/inventory/queries';

// GET /api/inventory/webhooks/log?limit=50&result=error — siste Woo-webhooks (30 dagers retensjon)
export default route({
  GET: async (req, res, { query }) => ({ data: await webhookLog({ limit: qLimit(query.limit, 50, 500), result: query.result || null }) }),
});

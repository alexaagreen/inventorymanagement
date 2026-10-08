// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit } from '../../../../lib/inventory/handler';
import { webhookLog } from '../../../../lib/inventory/queries';

// GET /api/inventory/webhooks/log?limit=50&result=error — recent Woo webhooks (30-day retention)
export default route({
  GET: async (req, res, { query }) => ({ data: await webhookLog({ limit: qLimit(query.limit, 50, 500), result: query.result || null }) }),
});

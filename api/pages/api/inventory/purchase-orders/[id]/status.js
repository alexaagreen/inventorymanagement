// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid, requireParam, withStatus } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';

// POST /api/inventory/purchase-orders/:id/status  { status: 'sent'|'cancelled'|'closed'|'draft' }
export default route({
  POST: async (req, res, { query, body, by }) =>
    withStatus(200, await rpc('set_purchase_order_status', [requireUuid(query.id), requireParam(body.status, 'status'), by])),
});

// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid, requireLines } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';

// POST /api/inventory/purchase-orders/:id/receive
//   { location?, received_at?, fx_rate?, note?, allow_over_receipt?, lines:[{ po_line_id | sku, qty, unit_cost?, landed_cost_per_unit?, note? }] }
export default route({
  POST: async (req, res, { query, body, by }) => {
    requireLines(body);
    return rpc('receive_purchase_order', [requireUuid(query.id), { ...body, by }]);
  },
});

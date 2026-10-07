// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// GET /api/inventory/stock/:sku → on_hand, available, on_order, next_delivery, avg_cost,
//   stock_value, last_purchase_*, locations[], open_consumption_qty, layers[]
export default route({
  GET: async (req, res, { query }) => rpc('get_item_status', [requireParam(query.sku, 'sku')]),
});

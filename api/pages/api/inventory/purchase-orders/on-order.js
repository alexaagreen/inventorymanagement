// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qList } from '../../../../lib/inventory/handler';
import { onOrder } from '../../../../lib/inventory/queries';

// GET /api/inventory/purchase-orders/on-order?sku=  → [{ sku, po_number, qty_open, expected_at }]
export default route({
  GET: async (req, res, { query }) => ({ data: await onOrder({ skus: qList(query.skus) || qList(query.sku) }) }),
});

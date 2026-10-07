// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qList, qDate, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { listPurchaseOrders } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET  /api/inventory/purchase-orders?status=sent,partially_received&supplier=&q=&from=&to=&limit=&cursor=
// POST /api/inventory/purchase-orders  { supplier_name, currency?, fx_rate?, location?, expected_at?, lines:[{sku, qty, unit_cost, landed_cost_per_unit?}] }
export default route({
  GET: async (req, res, { query }) => listPurchaseOrders({
    statuses: qList(query.status),
    supplier: query.supplier || null,
    q: query.q || null,
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
  POST: async (req, res, { body, by }) => {
    requireParam(body.supplier_name, 'supplier_name');
    requireLines(body);
    return rpc('create_purchase_order', { ...body, by });
  },
});

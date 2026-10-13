// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';

// GET    /api/inventory/items/:sku/suppliers
//   → [{ supplier_id, supplier_name, preferred, supplier_sku, list_price, list_currency, lead_time_days,
//        min_order_qty, last_purchase_at, last_unit_cost, last_currency, last_unit_cost_nok, qty_purchased, … }]
//   preferred first, then most recently bought from.
// POST   /api/inventory/items/:sku/suppliers  { supplier (id | code | name), preferred?, supplier_sku?, list_price?,
//          list_currency?, lead_time_days?, min_order_qty?, note?, pack_qty?, pack_name?, pack_gtin? }
//          → the updated list (link created or updated). pack_qty = our units in one supplier pack (v0.10.0).
// DELETE /api/inventory/items/:sku/suppliers?supplier=<id>  → the updated list
export default route({
  GET: async (req, res, { query }) => rpc('list_item_suppliers', [requireParam(query.sku, 'sku')]),
  POST: async (req, res, { query, body }) => {
    requireParam(body.supplier || body.supplier_id, 'supplier');
    return rpc('set_item_supplier', { ...body, sku: requireParam(query.sku, 'sku') });
  },
  DELETE: async (req, res, { query, body }) => rpc('remove_item_supplier', {
    sku: requireParam(query.sku, 'sku'),
    supplier: requireParam(query.supplier || body.supplier, 'supplier'),
  }),
}, { noPush: true });

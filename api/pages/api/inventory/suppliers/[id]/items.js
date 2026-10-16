// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qDate, isCsv } from '../../../../../lib/inventory/handler';
import { listSupplierItems } from '../../../../../lib/inventory/queries';
import { sendCsv } from '../../../../../lib/inventory/csv';

// GET /api/inventory/suppliers/:ref/items?from=&to=&q=&include_inactive=1&format=csv   (v0.10.0, read-only)
//   ref = uuid, code or name. Every product bought from this supplier, one row each:
//   sku, name, stock (on_hand, available, allocated, on_order, avg_cost, stock_value), the supplier link
//   (preferred, supplier_sku, pack_qty, pack_name, pack_gtin, list_price, last_unit_cost, last_purchase_at …)
//   and period_summary for [from, to) — default the last 90 days:
//   { movements, qty_in, qty_out, sold_net, received, adjusted, transferred_net, reversals, net_change, cogs, last_movement_at }
//   → { supplier: { id, name, code, currency, order_unit, rules[] }, period: { from, to }, count, data: [...] }
export default route({
  GET: async (req, res, { query }) => {
    const out = await listSupplierItems(query.id, {
      from: qDate(query.from, 'from'), to: qDate(query.to, 'to'),
      q: query.q || null, include_inactive: qBool(query.include_inactive) ?? false,
    });
    if (isCsv(query)) {
      return sendCsv(res, `supplier-items-${out.supplier.code || out.supplier.name}`.replace(/[^a-z0-9-]+/gi, '-') + '.csv',
        out.data.map(({ period_summary: ps, ...r }) => ({ ...r, ...Object.fromEntries(Object.entries(ps).map(([k, v]) => [`period_${k}`, v])) })));
    }
    return out;
  },
});

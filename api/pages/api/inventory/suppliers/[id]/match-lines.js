// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../../../lib/inventory/handler';
import { resolveSupplierId } from '../../../../../lib/inventory/queries';
import { rpc } from '../../../../../lib/inventory/rpc';

// POST /api/inventory/suppliers/:ref/match-lines (ref = uuid, code or name) — preview supplier invoice lines (no writes, v0.10.0)
//   { qty_in?: 'pack' | 'unit' (default: the supplier's order_unit),
//     lines: [{ supplier_sku?, gtin?, sku?, description?, qty, net_amount? | unit_price?, pack_qty? }] }
//   → 200 { supplier, qty_in, rules[], matched, unmatched, total_net,
//           lines: [{ row, matched, sku, item_name, qty, pack_qty, pack_qty_source, units, pack_price, unit_cost,
//                     net_amount, po_line }] }
//   Every matched line's po_line can be posted as-is in POST /purchase-orders { lines }. Unmatched lines
//   need a sku once (POST /items/:sku/suppliers { supplier, supplier_sku, pack_gtin, pack_qty }) —
//   after that the supplier's article number or GTIN is enough.
export default route({
  POST: async (req, res, { query, body }) => withStatus(200,
    await rpc('match_supplier_lines', { ...body, supplier: await resolveSupplierId(query.id) })),
}, { noPush: true });

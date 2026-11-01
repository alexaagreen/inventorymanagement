// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qList, qDate, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { listPurchaseOrders } from '../../../../lib/inventory/queries';
import { rpc, sql } from '../../../../lib/inventory/rpc';
import { InventoryError } from '../../../../lib/inventory/errors';

// GET  /api/inventory/purchase-orders?status=sent,partially_received&supplier=&q=&from=&to=&limit=&cursor=
// POST /api/inventory/purchase-orders  { supplier_id? (register uuid) | supplier_name, currency?, fx_rate?, location?, expected_at?,
//        lines:[{sku, qty, unit_cost, landed_cost_per_unit?}] }
//   v0.10.0 — a line may instead be given in supplier packs and by the supplier's identifiers:
//        {sku | supplier_sku | gtin, packs, pack_qty?, pack_price? | unit_cost, description?}
//   qty = packs × pack_qty (line, else the item↔supplier link, else parsed from the description, e.g. "(4x2,5kg)" → 4);
//   unit_cost = pack_price / pack_qty. Tip: POST /suppliers/:id/match-lines returns ready-made lines.
export default route({
  GET: async (req, res, { query }) => listPurchaseOrders({
    statuses: qList(query.status),
    supplier: query.supplier || null,
    supplier_id: query.supplier_id || null,
    q: query.q || null,
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
  POST: async (req, res, { body, by }) => {
    requireLines(body);
    let supplierName = body.supplier_name;
    if (!supplierName && body.supplier_id) {
      // A register uuid is enough: the PO trigger links it and shows the register name.
      const [s] = await sql('select name from inv.supplier where id::text = $1', [String(body.supplier_id)]);
      if (!s) throw new InventoryError('SUPPLIER_NOT_FOUND', 'supplier not found', { supplier: body.supplier_id });
      supplierName = s.name;
    }
    requireParam(supplierName, 'supplier_name');
    return rpc('create_purchase_order', { ...body, supplier_name: supplierName, by });
  },
});

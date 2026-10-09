// inventory-ledger v0.7.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';
import { InventoryError } from '../../../../lib/inventory/errors';

// POST /api/inventory/suppliers/import
//   { rows: [{ sku, supplier, supplier_sku?, preferred?, list_price?, list_currency?, lead_time_days?, min_order_qty? }],
//     dry_run?, create_suppliers? }
// Links items to suppliers in bulk. All-or-nothing: one invalid row → nothing is written (422 with errors).
// create_suppliers=true registers unknown supplier names instead of rejecting them.
export default route({
  POST: async (req, res, { body }) => {
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      throw new InventoryError('VALIDATION', 'rows must be a non-empty array', { field: 'rows' });
    }
    if (body.rows.length > 10000) throw new InventoryError('VALIDATION', 'max 10000 rows per import');
    const out = await rpc('import_item_suppliers', body);
    return withStatus(out.ok ? (out.dry_run ? 200 : 201) : 422, out);
  },
}, { noPush: true });

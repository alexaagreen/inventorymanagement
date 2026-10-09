// inventory-ledger v0.8.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../lib/inventory/handler';
import { rpc } from '../../../lib/inventory/rpc';
import { InventoryError } from '../../../lib/inventory/errors';

// POST /api/inventory/opening-balance  { rows: [{ sku, location?, qty, unit_cost }], dry_run?, occurred_at? }
// All-or-nothing: one invalid row → nothing is written, the response lists the errors.
// Idempotent per SKU × location (already imported rows are counted as existing).
export default route({
  POST: async (req, res, { body, by }) => {
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      throw new InventoryError('VALIDATION', 'rows must be a non-empty array', { field: 'rows' });
    }
    if (body.rows.length > 5000) throw new InventoryError('VALIDATION', 'max 5000 rows per import');
    const out = await rpc('import_opening_balance', { ...body, by });
    return withStatus(out.ok ? (out.dry_run ? 200 : 201) : 422, out);
  },
});

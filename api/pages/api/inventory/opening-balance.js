// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../lib/inventory/handler';
import { rpc } from '../../../lib/inventory/rpc';
import { InventoryError } from '../../../lib/inventory/errors';

// POST /api/inventory/opening-balance  { rows: [{ sku, location?, qty, unit_cost? }], dry_run?, occurred_at? }
// Operators upload CSV `sku;location;qty;unit_cost` (semicolon, decimal comma). The shop UI
// parses that file into these rows; numeric strings may keep the comma (12,5).
// All or nothing: one invalid row writes nothing, and the response lists the errors.
// Idempotent per SKU × location (rows already imported count as existing).
// Empty unit_cost uses the inbound cost chain and falls back to 0 when the item has no cost history.
// qty must be > 0. A zero-qty row is a validation error (the ledger cannot store a zero movement)
// and rejects the whole import.
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

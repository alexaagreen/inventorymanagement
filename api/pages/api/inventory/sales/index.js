// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// POST /api/inventory/sales  { ref_type?='manual_sale', ref_id, reference?, location?, occurred_at?, note?, lines:[{ sku, qty, ref_line? }] }
// Salg utenom Woo (B2B faktura, kassesalg uten Woo-ordre). Idempotent per (ref_type, ref_id, ref_line).
export default route({
  POST: async (req, res, { body, by }) => {
    requireParam(body.ref_id, 'ref_id');
    requireLines(body);
    return rpc('record_sale', { ...body, by });
  },
});

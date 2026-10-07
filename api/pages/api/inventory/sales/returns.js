// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// POST /api/inventory/sales/returns  { ref_type?='manual_return', ref_id, original_ref_type?, original_ref_id?, location?, lines:[{ sku, qty, unit_cost?, original_ref_line? }] }
export default route({
  POST: async (req, res, { body, by }) => {
    requireParam(body.ref_id, 'ref_id');
    requireLines(body);
    return rpc('record_sale_return', { ...body, by });
  },
});

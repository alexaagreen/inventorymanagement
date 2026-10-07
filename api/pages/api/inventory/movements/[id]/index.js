// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam } from '../../../../../lib/inventory/handler';
import { getMovement } from '../../../../../lib/inventory/queries';
import { InventoryError } from '../../../../../lib/inventory/errors';

// GET /api/inventory/movements/:id → movement + consumptions + layers + cogs_corrections
export default route({
  GET: async (req, res, { query }) => {
    const id = requireParam(query.id, 'id');
    if (!/^\d+$/.test(id)) throw new InventoryError('NOT_FOUND', 'movement not found');
    const m = await getMovement(id);
    if (!m) throw new InventoryError('NOT_FOUND', 'movement not found', { id });
    return m;
  },
});

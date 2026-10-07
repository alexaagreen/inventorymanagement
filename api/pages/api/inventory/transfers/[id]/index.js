// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid } from '../../../../../lib/inventory/handler';
import { getDoc } from '../../../../../lib/inventory/queries';
import { InventoryError } from '../../../../../lib/inventory/errors';

// GET /api/inventory/transfers/:id
export default route({
  GET: async (req, res, { query }) => {
    const d = await getDoc('transfer', requireUuid(query.id));
    if (!d) throw new InventoryError('NOT_FOUND', 'transfer not found', { id: query.id });
    return d;
  },
});

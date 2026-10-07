// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam, withStatus } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';
import { InventoryError } from '../../../../../lib/inventory/errors';

// POST /api/inventory/movements/:id/reverse  { note? }
export default route({
  POST: async (req, res, { query, body, by }) => {
    const id = requireParam(query.id, 'id');
    if (!/^\d+$/.test(id)) throw new InventoryError('NOT_FOUND', 'movement not found');
    return withStatus(201, await rpc('reverse_movement', [id, by, body.note || null]));
  },
});

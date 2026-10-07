// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid } from '../../../../../lib/inventory/handler';
import { getDoc } from '../../../../../lib/inventory/queries';
import { rpc } from '../../../../../lib/inventory/rpc';
import { InventoryError } from '../../../../../lib/inventory/errors';

// GET   /api/inventory/purchase-orders/:id
// PATCH /api/inventory/purchase-orders/:id  { header-felter?, lines? }
export default route({
  GET: async (req, res, { query }) => {
    const po = await getDoc('po', requireUuid(query.id));
    if (!po) throw new InventoryError('PO_NOT_FOUND', 'purchase order not found', { id: query.id });
    return po;
  },
  PATCH: async (req, res, { query, body, by }) => rpc('update_purchase_order', [requireUuid(query.id), { ...body, by }]),
});

// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid, withStatus } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';

// POST /api/inventory/adjustments/:id/reverse  { note? }
export default route({
  POST: async (req, res, { query, body, by }) =>
    withStatus(200, await rpc('reverse_adjustment', [requireUuid(query.id), by, body.note || null])),
});

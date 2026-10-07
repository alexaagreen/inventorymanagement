// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit } from '../../../../lib/inventory/handler';
import { listItems } from '../../../../lib/inventory/queries';

// GET /api/inventory/items?q=&active=&track_stock=&limit=&cursor=
export default route({
  GET: async (req, res, { query }) => listItems({
    q: query.q || null,
    active: qBool(query.active),
    track_stock: qBool(query.track_stock),
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
});

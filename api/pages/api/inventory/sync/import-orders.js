// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qDate, withStatus } from '../../../../lib/inventory/handler';
import { importOrders } from '../../../../lib/inventory/woo-order';

// POST /api/inventory/sync/import-orders?from=&to=&page=1 — backfill from Woo (idempotent).
// Returns next_page when the time budget is used up; call again with page=next_page.
export default route({
  POST: async (req, res, { query }) => withStatus(200, await importOrders({
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    page: Math.max(Number(query.page) || 1, 1),
  })),
}, { noPush: true });

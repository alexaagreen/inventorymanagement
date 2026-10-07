// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qDate } from '../../../../lib/inventory/handler';
import { listReceipts } from '../../../../lib/inventory/queries';

// GET /api/inventory/receipts?po_id=&from=&to=&limit=&cursor=
export default route({
  GET: async (req, res, { query }) => listReceipts({
    po_id: query.po_id || null,
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
});

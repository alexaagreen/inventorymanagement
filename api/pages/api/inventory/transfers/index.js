// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qDate, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { listTransfers } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET  /api/inventory/transfers?from=&to=&location=&limit=&cursor=
// POST /api/inventory/transfers  { from_location, to_location, note?, occurred_at?, lines:[{ sku, qty }] }
export default route({
  GET: async (req, res, { query }) => listTransfers({
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    location: query.location || null,
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
  POST: async (req, res, { body, by }) => {
    requireParam(body.from_location, 'from_location');
    requireParam(body.to_location, 'to_location');
    requireLines(body);
    return rpc('create_transfer', { ...body, by });
  },
});

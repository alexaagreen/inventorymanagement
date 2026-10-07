// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qDate, requireLines, requireParam } from '../../../../lib/inventory/handler';
import { listAdjustments } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET  /api/inventory/adjustments?from=&to=&location=&reason=&by=&q=&limit=&cursor=
// POST /api/inventory/adjustments  { location?, reason, note?, write_off?, occurred_at?,
//        lines:[{ sku, delta? | new_qty?, unit_cost?, revalue_to_unit_cost?, note? }] }
export default route({
  GET: async (req, res, { query }) => listAdjustments({
    from: qDate(query.from, 'from'),
    to: qDate(query.to, 'to'),
    location: query.location || null,
    reason: query.reason || null,
    by: query.by || null,
    q: query.q || null,
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
  POST: async (req, res, { body, by }) => {
    requireParam(body.reason, 'reason');
    requireLines(body);
    return rpc('create_adjustment', { ...body, by });
  },
});

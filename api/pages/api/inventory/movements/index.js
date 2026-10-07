// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate, isCsv, requireParam } from '../../../../lib/inventory/handler';
import { listMovements } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';
import { sendCsv } from '../../../../lib/inventory/csv';

// GET  /api/inventory/movements?sku=&skus=&type=sale,purchase_receipt&kind=salg&location=
//        &ref_type=&ref_id=&from=&to=&by=&q=&include_reversed=0&limit=&cursor=&count=1&format=csv
// POST /api/inventory/movements   { sku, type, qty, unit_cost?, location?, ref_type?, ref_id?, … }  (rå)
export default route({
  GET: async (req, res, { query }) => {
    const csv = isCsv(query);
    const out = await listMovements({
      skus: qList(query.skus) || qList(query.sku),
      types: qList(query.type),
      kinds: qList(query.kind),
      location: query.location || null,
      ref_type: query.ref_type || null,
      ref_id: query.ref_id || null,
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      by: query.by || null,
      q: query.q || null,
      include_reversed: qBool(query.include_reversed) ?? false,
      count: qBool(query.count) ?? false,
      limit: qLimit(query.limit),
      cursor: query.cursor,
      all: csv,
    });
    if (csv) {
      return sendCsv(res, 'vareflyt.csv', out.data, ['id', 'occurred_at', 'sku', 'item_name', 'location', 'type', 'kind', 'qty',
        'unit_cost', 'total_cost', 'cost_estimated', 'on_hand_after', 'reference', 'ref_type', 'ref_id', 'note', 'created_by']);
    }
    return out;
  },
  POST: async (req, res, { body, by }) => {
    requireParam(body.sku, 'sku');
    requireParam(body.type, 'type');
    return rpc('post_movement', { ...body, by });
  },
});

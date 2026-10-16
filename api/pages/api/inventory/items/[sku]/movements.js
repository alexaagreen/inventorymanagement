// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate, isCsv, requireParam } from '../../../../../lib/inventory/handler';
import { itemMovements } from '../../../../../lib/inventory/queries';
import { sendCsv } from '../../../../../lib/inventory/csv';

// GET /api/inventory/items/:sku/movements?from=&to=&type=&kind=&location=&include_reversed=0&limit=&cursor=&format=csv
//   (v0.10.0, read-only) One product's history:
//   → { item: { sku, name, on_hand, available, allocated, on_order, avg_cost, stock_value, locations, suppliers[] },
//       period: { from, to },            // default the last 90 days
//       summary: { movements, qty_in, qty_out, sold_net, received, adjusted, transferred_net, reversals, net_change, cogs, last_movement_at },
//       data: [movement…] newest first (on_hand_after = running stock at that location), next_cursor }
export default route({
  GET: async (req, res, { query }) => {
    const csv = isCsv(query);
    const out = await itemMovements(requireParam(query.sku, 'sku'), {
      types: qList(query.type), kinds: qList(query.kind), location: query.location || null,
      from: qDate(query.from, 'from'), to: qDate(query.to, 'to'),
      include_reversed: qBool(query.include_reversed) ?? false,
      limit: qLimit(query.limit), cursor: query.cursor, all: csv,
    });
    if (csv) return sendCsv(res, `movements-${out.item.sku}.csv`, out.data);
    return out;
  },
});

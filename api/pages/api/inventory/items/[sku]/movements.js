// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate, requireParam } from '../../../../../lib/inventory/handler';
import { itemMovements } from '../../../../../lib/inventory/queries';
import { exportFormat, sendExport, movementColumns, movementMeta } from '../../../../../lib/inventory/export';

// GET /api/inventory/items/:sku/movements?from=&to=&type=&kind=&location=&include_reversed=0&limit=&cursor=&format=csv|xlsx|pdf
//   (v0.10.0, read-only) One product's history:
//   → { item: { sku, name, on_hand, available, allocated, on_order, avg_cost, stock_value, locations, suppliers[] },
//       period: { from, to },            // default the last 90 days
//       summary: { movements, qty_in, qty_out, sold_net, received, adjusted, transferred_net, reversals, net_change, cogs, last_movement_at },
//       data: [movement…] newest first (on_hand_after = running stock at that location), next_cursor }
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await itemMovements(requireParam(query.sku, 'sku'), {
      types: qList(query.type), kinds: qList(query.kind), location: query.location || null,
      from: qDate(query.from, 'from'), to: qDate(query.to, 'to'),
      include_reversed: qBool(query.include_reversed) ?? false,
      limit: qLimit(query.limit), cursor: query.cursor, all: Boolean(fmt),
    });
    if (fmt) {
      return sendExport(res, fmt, {
        name: `movements-${out.item.sku}`,
        title: { nb: `Bevegelser ${out.item.sku}`, en: `Movements ${out.item.sku}` },
        meta: movementMeta({ ...query, from: query.from || out.period.from.slice(0, 10), to: query.to || out.period.to.slice(0, 10) },
          [[{ nb: 'Vare', en: 'Item' }, `${out.item.sku} ${out.item.name || ''}`.trim()]]),
        columns: movementColumns().filter((c) => c.key !== 'sku' && c.key !== 'item_name'),
        csvColumns: 'all', rows: out.data,
      }, ctx);
    }
    return out;
  },
});

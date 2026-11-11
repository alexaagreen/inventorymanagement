// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate } from '../../../../lib/inventory/handler';
import { saleCosts } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET /api/inventory/reports/sale-costs?from=&to=&source=&order_id=&order_ids=1,2&sku=&skus=&location=
//       &estimated=1&changed_since=&limit=&cursor=&format=csv|xlsx|pdf
// Cost per sold order line (spec §6.9). Period is on sold_at. The shop joins its own revenue
// lines on (source, order_id, line_id) to get margin.
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await saleCosts({
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      source: query.source || null,
      order_id: query.order_id || null,
      order_ids: qList(query.order_ids),
      skus: qList(query.skus) || qList(query.sku),
      location: query.location || null,
      estimated: qBool(query.estimated),
      changed_since: qDate(query.changed_since, 'changed_since'),
      limit: qLimit(query.limit),
      cursor: query.cursor,
      all: Boolean(fmt),
    });
    if (fmt) {
      return sendExport(res, fmt, {
        name: 'varekost-per-ordrelinje',
        title: { nb: 'Varekost per ordrelinje', en: 'Cost per order line' },
        meta: [
          [{ nb: 'Solgt fra', en: 'Sold from' }, out.from], [{ nb: 'Til (eksklusiv)', en: 'To (exclusive)' }, out.to],
          [{ nb: 'Lokasjon', en: 'Location' }, query.location ? String(query.location).toUpperCase() : null],
          [{ nb: 'Linjer med estimert kost', en: 'Lines with estimated cost' }, out.totals.estimated_lines ? String(out.totals.estimated_lines) : null],
        ],
        columns: cols(['sold_at', 'order_ref', 'source', 'order_id', 'line_id', 'sku', 'item_name', 'location',
          'qty_sold', 'qty_returned', 'qty_net', 'cogs', 'unit_cogs', 'cost_estimated', 'last_cost_change_at']),
        rows: out.data,
      }, ctx);
    }
    return out;
  },
});

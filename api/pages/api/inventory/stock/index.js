// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, isCsv } from '../../../../lib/inventory/handler';
import { listStock } from '../../../../lib/inventory/queries';
import { sendCsv } from '../../../../lib/inventory/csv';

// GET /api/inventory/stock?sku=&skus=A,B&location=&negative=1&below_reorder=1&q=&active=&limit=&cursor=&format=csv
export default route({
  GET: async (req, res, { query }) => {
    const csv = isCsv(query);
    const skus = qList(query.skus) || qList(query.sku);
    const out = await listStock({
      skus,
      location: query.location || null,
      negative: qBool(query.negative),
      below_reorder: qBool(query.below_reorder),
      active: qBool(query.active),
      q: query.q || null,
      limit: skus ? Math.min(skus.length, 500) : qLimit(query.limit),
      cursor: query.cursor,
      all: csv,
    });
    if (csv) {
      const cols = query.location
        ? ['sku', 'name', 'location', 'on_hand', 'value', 'avg_cost', 'last_movement_at']
        : ['sku', 'name', 'on_hand', 'available', 'on_order', 'next_delivery', 'avg_cost', 'stock_value', 'last_purchase_cost', 'reorder_point'];
      return sendCsv(res, 'lagerstatus.csv', out.data, cols);
    }
    return out;
  },
});

// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList } from '../../../../lib/inventory/handler';
import { listStock } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET /api/inventory/stock?sku=&skus=A,B&location=&negative=1&below_reorder=1&no_supplier=1&supplier_id=&q=&active=&limit=&cursor=&format=csv|xlsx|pdf
//   no_supplier=1 → tracked items without any supplier. Rows also carry preferred_supplier, supplier_count and the last purchase (last_supplier, last_unit_cost,
//   last_currency, last_unit_cost_nok, last_po_number).
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const skus = qList(query.skus) || qList(query.sku);
    const out = await listStock({
      skus,
      location: query.location || null,
      negative: qBool(query.negative),
      below_reorder: qBool(query.below_reorder),
      no_supplier: qBool(query.no_supplier),
      supplier_id: query.supplier_id || null,
      active: qBool(query.active),
      q: query.q || null,
      limit: skus ? Math.min(skus.length, 500) : qLimit(query.limit),
      cursor: query.cursor,
      all: Boolean(fmt),
    });
    if (fmt) {
      const csvColumns = query.location
        ? ['sku', 'name', 'location', 'on_hand', 'value', 'avg_cost', 'last_movement_at']
        : ['sku', 'name', 'on_hand', 'available', 'on_order', 'next_delivery', 'avg_cost', 'stock_value', 'last_purchase_cost', 'reorder_point',
          'preferred_supplier', 'supplier_count', 'last_supplier', 'last_unit_cost', 'last_currency', 'last_unit_cost_nok'];
      const columns = query.location
        ? cols(['sku', 'name', 'location', 'on_hand', 'avg_cost', 'value', 'last_movement_at'])
        : cols(['sku', 'name', 'on_hand', 'available', 'on_order', 'next_delivery', 'avg_cost', 'stock_value', 'preferred_supplier', 'last_unit_cost_nok']);
      const filters = [qBool(query.negative) && { nb: 'negativ', en: 'negative' }, qBool(query.below_reorder) && { nb: 'under bestillingspunkt', en: 'below reorder point' },
        qBool(query.no_supplier) && { nb: 'uten leverandør', en: 'no supplier' }].filter(Boolean);
      return sendExport(res, fmt, {
        name: 'lagerstatus',
        title: { nb: 'Lagerstatus', en: 'Stock status' },
        meta: [
          [{ nb: 'Lokasjon', en: 'Location' }, query.location ? String(query.location).toUpperCase() : null],
          [{ nb: 'Søk', en: 'Search' }, query.q || null],
          [{ nb: 'Filter', en: 'Filter' }, filters.length ? { nb: filters.map((f) => f.nb).join(', '), en: filters.map((f) => f.en).join(', ') } : null],
        ],
        columns, csvColumns, rows: out.data,
      }, ctx);
    }
    return out;
  },
});

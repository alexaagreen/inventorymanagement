// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../lib/inventory/handler';
import { valuation } from '../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../lib/inventory/export';

// GET /api/inventory/valuation?location=&format=csv|xlsx|pdf
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await valuation({ location: query.location || null });
    if (fmt) {
      return sendExport(res, fmt, {
        name: `lagerverdi${out.location ? '-' + out.location : ''}`,
        title: { nb: 'Lagerverdi', en: 'Stock value' },
        meta: [[{ nb: 'Lokasjon', en: 'Location' }, out.location ? String(out.location).toUpperCase() : { nb: 'Alle', en: 'All' }]],
        columns: cols(['sku', 'name', 'on_hand', 'avg_cost', 'value']),
        rows: out.rows,
      }, ctx);
    }
    return out;
  },
});

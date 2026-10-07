// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, isCsv } from '../../../lib/inventory/handler';
import { valuation } from '../../../lib/inventory/queries';
import { sendCsv } from '../../../lib/inventory/csv';

// GET /api/inventory/valuation?location=&format=csv
export default route({
  GET: async (req, res, { query }) => {
    const out = await valuation({ location: query.location || null });
    if (isCsv(query)) return sendCsv(res, 'lagerverdi.csv', out.rows, ['sku', 'name', 'on_hand', 'avg_cost', 'value']);
    return out;
  },
});

// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qDate, isCsv } from '../../../../lib/inventory/handler';
import { cogsReport } from '../../../../lib/inventory/queries';
import { sendCsv } from '../../../../lib/inventory/csv';

// GET /api/inventory/reports/cogs?from=&to=&group_by=sku|day|ref&location=&format=csv
export default route({
  GET: async (req, res, { query }) => {
    const out = await cogsReport({
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      group_by: query.group_by || 'sku',
      location: query.location || null,
    });
    if (isCsv(query)) return sendCsv(res, 'varekost.csv', out.rows, ['key', 'qty_sold', 'qty_returned', 'cogs', 'has_estimates']);
    return out;
  },
});

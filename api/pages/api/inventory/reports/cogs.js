// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qDate } from '../../../../lib/inventory/handler';
import { cogsReport } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET /api/inventory/reports/cogs?from=&to=&group_by=sku|day|ref&location=&format=csv|xlsx|pdf
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await cogsReport({
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      group_by: query.group_by || 'sku',
      location: query.location || null,
    });
    if (fmt) {
      const keyLabel = { sku: { nb: 'SKU', en: 'SKU' }, day: { nb: 'Dato', en: 'Date' }, ref: { nb: 'Referanse', en: 'Reference' } }[out.group_by];
      return sendExport(res, fmt, {
        name: 'varekost',
        title: { nb: 'Varekost (COGS)', en: 'Cost of goods sold' },
        meta: [
          [{ nb: 'Fra', en: 'From' }, out.from], [{ nb: 'Til (eksklusiv)', en: 'To (exclusive)' }, out.to],
          [{ nb: 'Lokasjon', en: 'Location' }, query.location ? String(query.location).toUpperCase() : null],
          [{ nb: 'Korreksjoner bokført i perioden (NOK)', en: 'Corrections booked in the period (NOK)' }, String(out.corrections_booked_in_period)],
        ],
        columns: cols([{ key: 'key', ...keyLabel, type: out.group_by === 'day' ? 'date' : 'code' }, 'qty_sold', 'qty_returned', 'cogs', 'has_estimates']),
        rows: out.rows,
      }, ctx);
    }
    return out;
  },
});

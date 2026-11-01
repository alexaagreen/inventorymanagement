// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam } from '../../../../lib/inventory/handler';
import { stockAsOf } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET /api/inventory/reports/stock-as-of?at=YYYY-MM-DD|ISO&by=sku|location&location=&q=&format=csv|xlsx|pdf   (v0.11.0)
//   Stock (qty and FIFO value) as it was at a point in time, rebuilt from the ledger now — not frozen,
//   so backdated movements are included. A bare date means the end of that day (shop time zone).
//   → { at, cutoff_at, totals: { rows, qty, value }, rows: [{ sku, name, qty, value, unit_cost, locations }] }
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const by = query.by === 'location' ? 'location' : 'sku';
    const out = await stockAsOf({ at: requireParam(query.at, 'at'), by, location: query.location || null, q: query.q || null });
    if (fmt) {
      const day = String(out.at).slice(0, 10);
      return sendExport(res, fmt, {
        name: `lager-per-${day}${out.location ? '-' + out.location : ''}`,
        title: { nb: `Lager per ${day}`, en: `Stock as of ${day}` },
        sheet: day,
        meta: [
          [{ nb: 'Tidspunkt', en: 'As of' }, /^\d{4}-\d{2}-\d{2}$/.test(String(out.at)) ? { nb: `slutten av ${day}`, en: `end of ${day}` } : String(out.at)],
          [{ nb: 'Grunnlag', en: 'Basis' }, { nb: 'beregnet fra ledgeren nå (ikke fryst)', en: 'rebuilt from the ledger now (not frozen)' }],
          [{ nb: 'Lokasjon', en: 'Location' }, out.location ? String(out.location).toUpperCase() : { nb: 'Alle', en: 'All' }],
          [{ nb: 'Søk', en: 'Search' }, out.q],
        ],
        columns: cols(['sku', 'name', by === 'location' && 'location', 'qty', 'unit_cost', 'value']),
        csvColumns: ['sku', 'name', ...(by === 'location' ? ['location'] : []), 'qty', 'value', 'unit_cost'],
        rows: out.rows,
      }, ctx);
    }
    return out;
  },
});

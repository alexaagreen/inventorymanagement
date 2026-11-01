// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, isCsv, requireParam } from '../../../../lib/inventory/handler';
import { stockAsOf } from '../../../../lib/inventory/queries';
import { sendCsv } from '../../../../lib/inventory/csv';

// GET /api/inventory/reports/stock-as-of?at=YYYY-MM-DD|ISO&by=sku|location&location=&q=&format=csv   (v0.11.0)
//   Stock (qty and FIFO value) as it was at a point in time, rebuilt from the ledger now — not frozen,
//   so backdated movements are included. A bare date means the end of that day (shop time zone).
//   → { at, cutoff_at, totals: { rows, qty, value }, rows: [{ sku, name, qty, value, unit_cost, locations }] }
export default route({
  GET: async (req, res, { query }) => {
    const by = query.by === 'location' ? 'location' : 'sku';
    const out = await stockAsOf({ at: requireParam(query.at, 'at'), by, location: query.location || null, q: query.q || null });
    if (isCsv(query)) {
      return sendCsv(res, `lager-per-${String(out.at).slice(0, 10)}.csv`, out.rows,
        ['sku', 'name', ...(by === 'location' ? ['location'] : []), 'qty', 'value', 'unit_cost']);
    }
    return out;
  },
});

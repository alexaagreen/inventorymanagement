// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, isCsv } from '../../../../lib/inventory/handler';
import { getMonthClose } from '../../../../lib/inventory/queries';
import { sendCsv } from '../../../../lib/inventory/csv';

// GET /api/inventory/month-close/:period?by=sku|location&location=&q=&compare=0&format=csv   (v0.11.0)
//   :period = 'YYYY-MM'. One closed month:
//   → { close: { …header, backdated_movements, history[] },
//       older, newer: neighbouring closed months ('YYYY-MM' | null) for paging through time,
//       previous_period: the month before when it is closed (rows then carry prev_qty, prev_value, delta_qty, delta_value),
//       totals: { rows, qty, value, prev_qty?, prev_value?, delta_value? },
//       rows: [{ sku, name, qty, value, unit_cost, locations: { CODE: { qty, value } } }]   (by=sku, default)
//          or [{ sku, name, location, qty, value, unit_cost }]                              (by=location) }
//   404 NOT_FOUND when the month is not closed (POST /month-close { period } closes it).
export default route({
  GET: async (req, res, { query }) => {
    const by = query.by === 'location' ? 'location' : 'sku';
    const out = await getMonthClose(query.period, {
      by, location: query.location || null, q: query.q || null, compare: qBool(query.compare) ?? true,
    });
    if (isCsv(query)) {
      const cols = ['sku', 'name', ...(by === 'location' ? ['location'] : []), 'qty', 'value', 'unit_cost',
        ...(out.previous_period ? ['prev_qty', 'prev_value', 'delta_qty', 'delta_value'] : [])];
      return sendCsv(res, `lager-maanedsslutt-${out.close.period}${out.location ? '-' + out.location : ''}.csv`, out.rows, cols);
    }
    return out;
  },
});

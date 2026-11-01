// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool } from '../../../../lib/inventory/handler';
import { getMonthClose } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols, periodLabel } from '../../../../lib/inventory/export';

// GET /api/inventory/month-close/:period?by=sku|location&location=&q=&compare=0&format=csv|xlsx|pdf   (v0.11.0)
//   :period = 'YYYY-MM'. One closed month:
//   → { close: { …header, backdated_movements, history[] },
//       older, newer: neighbouring closed months ('YYYY-MM' | null) for paging through time,
//       previous_period: the month before when it is closed (rows then carry prev_qty, prev_value, delta_qty, delta_value),
//       totals: { rows, qty, value, prev_qty?, prev_value?, delta_value? },
//       rows: [{ sku, name, qty, value, unit_cost, locations: { CODE: { qty, value } } }]   (by=sku, default)
//          or [{ sku, name, location, qty, value, unit_cost }]                              (by=location) }
//   404 NOT_FOUND when the month is not closed (POST /month-close { period } closes it).
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const by = query.by === 'location' ? 'location' : 'sku';
    const out = await getMonthClose(query.period, {
      by, location: query.location || null, q: query.q || null, compare: qBool(query.compare) ?? true,
    });
    if (fmt) {
      const c = out.close;
      const p = periodLabel(c.period);
      const prev = out.previous_period ? periodLabel(out.previous_period) : null;
      const at = (v) => String(v instanceof Date ? v.toISOString() : v);
      return sendExport(res, fmt, {
        name: `lager-maanedsslutt-${c.period}${out.location ? '-' + out.location : ''}`,
        title: { nb: `Lager ved månedsslutt – ${p.nb}`, en: `Stock at month end – ${p.en}` },
        sheet: c.period,
        meta: [
          [{ nb: 'Per', en: 'As of' }, { nb: `slutten av ${p.nb} (${c.timezone})`, en: `end of ${p.en} (${c.timezone})` }],
          [{ nb: 'Lukket', en: 'Closed' }, c.recalc_count
            ? { nb: `${at(c.recalculated_at).slice(0, 10)}, rekalkulert av ${c.recalculated_by || '—'}`, en: `${at(c.recalculated_at).slice(0, 10)}, recalculated by ${c.recalculated_by || '—'}` }
            : { nb: `${at(c.closed_at).slice(0, 10)} av ${c.closed_by || c.source}`, en: `${at(c.closed_at).slice(0, 10)} by ${c.closed_by || c.source}` }],
          [{ nb: 'Lokasjon', en: 'Location' }, out.location ? String(out.location).toUpperCase() : { nb: 'Alle', en: 'All' }],
          [{ nb: 'Søk', en: 'Search' }, out.q],
          [{ nb: 'Sammenlignet med', en: 'Compared with' }, prev],
          [{ nb: 'OBS', en: 'Note' }, c.backdated_movements > 0
            ? { nb: `${c.backdated_movements} bevegelse(r) er bokført inn i måneden etter lukking — ikke med i tallene`,
              en: `${c.backdated_movements} movement(s) posted into this month after closing — not included` } : null],
        ],
        columns: cols(['sku', 'name', by === 'location' && 'location', 'qty', 'unit_cost', 'value',
          ...(prev ? ['prev_qty', 'delta_qty', 'prev_value', 'delta_value'] : [])]),
        csvColumns: ['sku', 'name', ...(by === 'location' ? ['location'] : []), 'qty', 'value', 'unit_cost',
          ...(prev ? ['prev_qty', 'prev_value', 'delta_qty', 'delta_value'] : [])],
        rows: out.rows,
      }, ctx);
    }
    return out;
  },
});

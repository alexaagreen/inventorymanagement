// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, withStatus } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';
import { listMonthCloses, requirePeriod } from '../../../../lib/inventory/queries';

// End-of-month report (v0.11.0): qty and value per SKU frozen at the end of each month.
//
// GET  /api/inventory/month-close
//   → { data: [{ id, period 'YYYY-MM', cutoff_at, total_qty, total_value, sku_count, line_count, negative_lines,
//               source, closed_by, closed_at, recalculated_at, recalc_count, backdated_movements,
//               prev_total_value, delta_value }] newest first,
//       first_period, last_completed, missing: ['YYYY-MM', …] (completed months without a close) }
// POST /api/inventory/month-close { period: 'YYYY-MM', recalculate?: bool, note? }
//   → 201 the close (action: closed) | 200 (action: existing | recalculated)
// POST /api/inventory/month-close { all_missing: true }
//   → 200 { closed: ['YYYY-MM', …], existing, from, through } — closes every completed month without a close
//     (backfill: the first call builds the whole history from the first movement on)
export default route({
  GET: async () => listMonthCloses(),
  POST: async (req, res, { body, by }) => {
    if (qBool(body?.all_missing)) {
      return withStatus(200, await rpc('close_due_months', { by, source: 'backfill', ignore_grace: true }));
    }
    const out = await rpc('close_month', {
      period: requirePeriod(body?.period), by, source: 'manual',
      recalculate: qBool(body?.recalculate) ?? false, note: body?.note ?? null,
    });
    return withStatus(out.action === 'closed' ? 201 : 200, out);
  },
}, { noPush: true });

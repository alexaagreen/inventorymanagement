// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../../lib/inventory/handler';
import { getNorgesBankRate } from '../../../../lib/inventory/fx';

// GET /api/inventory/fx/norges-bank?currency=JPY&date=2026-10-07
//   → { currency, rate (NOK per 1 unit), quoted, per_units, date (observation), requested_date, source }
// Reference only — the UI shows it next to the fx field; nothing is written.
export default route({
  GET: async (req, res, ctx) => getNorgesBankRate(ctx.query.currency, ctx.query.date),
});

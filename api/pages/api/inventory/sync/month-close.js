// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// POST|GET /api/inventory/sync/month-close — monthly cron (v0.11.0)
//   Closes every completed month that has no close yet (normally just last month). A month is closed
//   when its end is at least month_close_grace_hours (2) ago, so late webhooks and the order backfill
//   land first. Idempotent. Suggested schedule: "15 2 1 * *" (UTC — 03:15/04:15 Oslo on the 1st).
//   → { closed: ['YYYY-MM', …], existing, from, through }
const run = async (req, res, { by }) => withStatus(200, await rpc('close_due_months', { by: by || 'cron', source: 'scheduled' }));
export default route({ GET: run, POST: run }, { noPush: true });

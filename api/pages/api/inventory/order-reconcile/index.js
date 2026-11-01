// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qDate, qLimit, qList, withStatus } from '../../../../lib/inventory/handler';
import { listOrderReconcileRuns } from '../../../../lib/inventory/queries';
import { reconcileOrders } from '../../../../lib/inventory/order-reconcile';

// Order reconcile (v0.9.0): re-applies every Woo order modified in a window and records what
// changed and what needs a human (inv.order_reconcile_run / inv.order_reconcile_issue).
//
// GET  /api/inventory/order-reconcile?status=ok,issues,partial,failed,running&limit=&cursor=
//   → { data: [{ id, trigger, run_by, status, window_from, window_to, started_at, finished_at, duration_ms,
//               orders_checked, orders_changed, movements, missing_checked, issues_new, issues_seen,
//               issues_resolved, issues_open, error }], next_cursor }
// POST /api/inventory/order-reconcile  { days? (1–35), from?, to? }
//   → 200 the finished run (with log[] and changes[]); 409 RECONCILE_RUNNING while another run is active.
//   Runs within the request (up to ~4 minutes); a run that runs out of time ends as 'partial'.
export const config = { maxDuration: 300 };

export default route({
  GET: async (req, res, { query }) => listOrderReconcileRuns({
    status: qList(query.status), limit: qLimit(query.limit, 50), cursor: query.cursor,
  }),
  POST: async (req, res, { body, by }) => withStatus(200, await reconcileOrders({
    trigger: 'manual', by,
    days: body?.days ?? null,
    from: qDate(body?.from, 'from'),
    to: qDate(body?.to, 'to'),
  })),
}, { noPush: true });

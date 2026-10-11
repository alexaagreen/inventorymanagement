// inventory-ledger v0.9.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../../lib/inventory/handler';
import { syncStatus } from '../../../../lib/inventory/woo-push';
import { orderReconcileSummary } from '../../../../lib/inventory/queries';

// GET /api/inventory/sync/status → { queue_size, oldest_requested_at, last_push_at, failed_items, last_reconcile, …,
//                                    order_reconcile: { last_run, last_completed_at, open_issues } }
export default route({ GET: async () => ({ ...(await syncStatus()), order_reconcile: await orderReconcileSummary() }) });

// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../../lib/inventory/handler';
import { syncStatus } from '../../../../lib/inventory/woo-push';

// GET /api/inventory/sync/status → { queue_size, oldest_requested_at, last_push_at, failed_items, last_reconcile, … }
export default route({ GET: async () => syncStatus() });

// inventory-ledger v0.9.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid } from '../../../../lib/inventory/handler';
import { getOrderReconcileRun } from '../../../../lib/inventory/queries';

// GET /api/inventory/order-reconcile/:id → run + log[] ({at, level, message}) + changes[] + issues[] seen in the run
export default route({ GET: async (req, res, { query }) => getOrderReconcileRun(requireUuid(query.id)) });

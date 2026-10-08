// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, withStatus } from '../../../../lib/inventory/handler';
import { reconcile } from '../../../../lib/inventory/woo-push';

// POST|GET /api/inventory/sync/reconcile?fix=1 — Woo stock_quantity vs ledger available (daily cron)
const run = async (req, res, { query }) => withStatus(200, await reconcile({ fix: qBool(query.fix) ?? false }));
export default route({ GET: run, POST: run }, { noPush: true });

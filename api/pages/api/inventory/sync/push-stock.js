// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, withStatus } from '../../../../lib/inventory/handler';
import { pushStock } from '../../../../lib/inventory/woo-push';

// POST|GET /api/inventory/sync/push-stock?limit=100 — drener push-køen (cron hvert minutt + etter skriv)
const run = async (req, res, { query }) => withStatus(200, await pushStock({ limit: qLimit(query.limit, 100, 500) }));
export default route({ GET: run, POST: run }, { noPush: true });

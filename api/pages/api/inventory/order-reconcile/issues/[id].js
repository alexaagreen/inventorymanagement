// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid } from '../../../../../lib/inventory/handler';
import { rpc } from '../../../../../lib/inventory/rpc';

// PATCH /api/inventory/order-reconcile/issues/:id  { action: 'resolve' | 'ignore' | 'reopen', note? }
//   resolve → closed; reported again (as a new issue) if a later run still finds the problem
//   ignore  → closed for good; later runs never report this order line again
//   reopen  → back to open (409 IMMUTABLE when a newer open issue exists)
export default route({
  PATCH: async (req, res, { query, body, by }) => rpc('resolve_order_reconcile_issue', {
    id: requireUuid(query.id), action: body?.action || 'resolve', note: body?.note ?? null, by,
  }),
}, { noPush: true });

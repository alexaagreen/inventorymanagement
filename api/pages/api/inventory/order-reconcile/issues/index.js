// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qList } from '../../../../../lib/inventory/handler';
import { listOrderReconcileIssues } from '../../../../../lib/inventory/queries';

// GET /api/inventory/order-reconcile/issues?status=open|resolved|ignored|all&kind=&order=&limit=&cursor=
//   → { data: [{ id, kind, woo_order_id, order_number, ref, sku, woo_qty, ledger_qty, message, details,
//               first_seen_at, last_seen_at, seen_count, resolved_at, resolved_by, resolution, note }],
//       next_cursor, counts: { open, ignored } }
//   kind: unmatched_sku | line_mismatch | refund_missing_in_woo | order_missing_in_woo | apply_failed
export default route({
  GET: async (req, res, { query }) => listOrderReconcileIssues({
    status: query.status || 'open', kind: qList(query.kind), order: query.order || null,
    limit: qLimit(query.limit, 100), cursor: query.cursor,
  }),
});

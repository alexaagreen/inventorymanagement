// inventory-ledger v0.9.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit } from '../../../../lib/inventory/handler';
import { listSuppliers } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET  /api/inventory/suppliers?q=&active=&limit=&cursor=
//   → { data: [{ id, name, code, currency, …, item_count, preferred_count, open_po_count, last_receipt_at }], next_cursor }
// POST /api/inventory/suppliers  { name, code?, currency?, contact_name?, email?, phone?, website?,
//                                  default_lead_time_days?, note? }  → 201 supplier (409 DUPLICATE_REF on same name)
export default route({
  GET: async (req, res, { query }) => listSuppliers({
    q: query.q || null,
    active: qBool(query.active),
    limit: qLimit(query.limit),
    cursor: query.cursor,
  }),
  POST: async (req, res, { body }) => {
    const { id, ...rest } = body; // create only; PATCH /suppliers/:id updates
    return rpc('upsert_supplier', rest);
  },
}, { noPush: true });

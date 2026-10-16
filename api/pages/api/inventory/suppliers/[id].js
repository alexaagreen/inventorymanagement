// inventory-ledger v0.10.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../../lib/inventory/handler';
import { getSupplier, resolveSupplierId } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET   /api/inventory/suppliers/:ref  — ref = uuid, code or name (case-insensitive, URL-encoded)
//   → supplier (incl. rules[], order_unit) + items[] (with last price and pack data) + purchase_orders[] (latest 20)
// PATCH /api/inventory/suppliers/:ref  { name?, code?, currency?, contact_name?, email?, phone?, website?,
//                                        default_lead_time_days?, note?, active?, order_unit?, rules? }
export default route({
  GET: async (req, res, { query }) => getSupplier(query.id),
  PATCH: async (req, res, { query, body }) => {
    const id = await resolveSupplierId(query.id);
    await rpc('upsert_supplier', { ...body, id });
    return getSupplier(id);
  },
}, { noPush: true });

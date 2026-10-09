// inventory-ledger v0.7.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireUuid } from '../../../../lib/inventory/handler';
import { getSupplier } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';

// GET   /api/inventory/suppliers/:id  → supplier + items[] (with last price from this supplier) + purchase_orders[] (latest 20)
// PATCH /api/inventory/suppliers/:id  { name?, code?, currency?, contact_name?, email?, phone?, website?,
//                                       default_lead_time_days?, note?, active? }
export default route({
  GET: async (req, res, { query }) => getSupplier(requireUuid(query.id)),
  PATCH: async (req, res, { query, body }) => {
    const id = requireUuid(query.id);
    await rpc('upsert_supplier', { ...body, id });
    return getSupplier(id);
  },
}, { noPush: true });

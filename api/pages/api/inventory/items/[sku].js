// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireParam } from '../../../../lib/inventory/handler';
import { rpc, sql } from '../../../../lib/inventory/rpc';
import { InventoryError } from '../../../../lib/inventory/errors';

// Felt som eies av ledgeren. sku/navn/Woo-id/track_stock eies av WooCommerce (synces inn).
const EDITABLE = ['reorder_point', 'reorder_qty', 'attributes'];

// GET   /api/inventory/items/:sku  → item + status + lokasjoner + lag
// PATCH /api/inventory/items/:sku  { reorder_point?, reorder_qty?, attributes? }
export default route({
  GET: async (req, res, { query }) => rpc('get_item_status', [requireParam(query.sku, 'sku')]),
  PATCH: async (req, res, { query, body }) => {
    const sku = requireParam(query.sku, 'sku');
    const extra = Object.keys(body).filter((k) => !EDITABLE.includes(k) && k !== 'by');
    if (extra.length) {
      throw new InventoryError('VALIDATION', `fields managed by WooCommerce cannot be changed here: ${extra.join(', ')}`, { fields: extra });
    }
    const [item] = await sql('select sku from inv.item where id = inv._resolve_item($1)', [sku]);
    const patch = { sku: item.sku };
    for (const k of EDITABLE) if (k in body) patch[k] = body[k];
    await rpc('upsert_item', patch);
    return rpc('get_item_status', [item.sku]);
  },
});

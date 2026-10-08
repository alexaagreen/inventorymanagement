// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Call an inv.* function and get jsonb back. Errors from inv._raise() become InventoryError.
//   await rpc('create_adjustment', body)
//   await rpc('receive_purchase_order', [poId, body])     // several arguments
import { query } from './db';
import { fromPgError } from './errors';

const NAME_RE = /^[a-z_][a-z0-9_]*$/;

// Types for arguments that are not jsonb (the rest are sent as jsonb)
const ARG_TYPES = {
  update_purchase_order: ['uuid', 'jsonb'],
  set_purchase_order_status: ['uuid', 'text', 'text'],
  receive_purchase_order: ['uuid', 'jsonb'],
  reverse_movement: ['bigint', 'text', 'text'],
  reverse_adjustment: ['uuid', 'text', 'text'],
  reverse_goods_receipt: ['uuid', 'text', 'text'],
  reverse_transfer: ['uuid', 'text', 'text'],
  get_item_status: ['text'],
  apply_woo_order: ['jsonb', 'text'],
  apply_woo_refund: ['bigint', 'jsonb'],
  list_stock_push_due: ['int'],
  mark_stock_pushed: ['uuid', 'numeric', 'boolean', 'text'],
  enqueue_stock_push: ['text[]'],
  log_woo_webhook: ['text', 'text', 'text', 'text'],
};

export async function rpc(fn, args = []) {
  if (!NAME_RE.test(fn)) throw new Error(`invalid function name ${fn}`);
  const list = Array.isArray(args) ? args : [args];
  const types = ARG_TYPES[fn] || list.map(() => 'jsonb');
  const params = list.map((a, i) => (types[i] === 'jsonb' && a != null ? JSON.stringify(a) : a));
  const placeholders = list.map((_, i) => `$${i + 1}::${types[i] || 'jsonb'}`).join(', ');
  try {
    const { rows } = await query(`select inv.${fn}(${placeholders}) as r`, params);
    return rows[0]?.r ?? null;
  } catch (err) {
    throw fromPgError(err);
  }
}

/** Run arbitrary parameterized SQL with the same error mapping (for read queries). */
export async function sql(text, params = []) {
  try {
    const { rows } = await query(text, params);
    return rows;
  } catch (err) {
    throw fromPgError(err);
  }
}

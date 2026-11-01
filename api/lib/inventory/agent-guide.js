// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Machine-readable guide for AI agents and scripts: GET /api/inventory/guide (JSON) or
// GET /api/inventory/guide?format=md (Markdown). Also served at GET /api/inventory. Keep it short, concrete and in sync with the routes.

export const GUIDE = {
  name: 'inventory-ledger API',
  version: '0.11.0',
  guide: 'GET /api/inventory/guide (JSON) or /api/inventory/guide?format=md',
  about: 'FIFO stock ledger. The ledger is master for stock; WooCommerce is master for products. All amounts are NOK unless a currency is given. Quantities are in the units we stock and sell.',
  auth: {
    header: 'Authorization: Bearer <INVENTORY_API_KEY>',
    attribution: 'Send x-inventory-by: <your name, e.g. grokbot> so writes are attributed to you.',
    note: 'Reads are safe. Writes (POST/PATCH) change stock or documents — preview first where a preview exists.',
  },
  conventions: [
    'Lists return { data, next_cursor }. Pass cursor=<next_cursor> for the next page; limit ≤ 500.',
    'format=csv on list endpoints returns the whole selection as CSV (semicolon, decimal comma).',
    'Dates: ISO 8601. Periods are [from, to); movement summaries default to the last 90 days.',
    'A supplier can be addressed by uuid, code or name (case-insensitive, URL-encoded) wherever :supplier appears.',
    'Errors: { error: { code, message, details } } with HTTP 400/404/409/422.',
  ],
  read: [
    { method: 'GET', path: '/api/inventory/suppliers', params: 'q, active, limit, cursor', returns: 'suppliers with item_count, preferred_count, open_po_count, last_receipt_at, order_unit, rules[]' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier', returns: 'one supplier: contact data, rules[] (read them before entering anything), order_unit (unit | pack), items[], purchase_orders[]' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier/items', params: 'from, to, q, include_inactive=1, format=csv',
      returns: 'every product bought from the supplier with stock (on_hand, available, on_order, avg_cost, stock_value), the link (supplier_sku, pack_qty, pack_gtin, last_unit_cost, last_purchase_at) and period_summary { sold_net, received, adjusted, net_change, cogs, movements, last_movement_at }' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier/movements', params: 'from, to, type, kind, location, limit, cursor, format=csv', returns: 'movements of all the supplier\'s products, newest first' },
    { method: 'GET', path: '/api/inventory/items/:sku/movements', params: 'from, to, type, kind, location, include_reversed, limit, cursor, format=csv',
      returns: '{ item (stock + suppliers[]), period, summary, data: movements newest first, next_cursor }' },
    { method: 'GET', path: '/api/inventory/stock', params: 'q, sku, skus=A,B, supplier_id, below_reorder=1, negative=1, no_supplier=1, location, limit, cursor, format=csv', returns: 'stock per item incl. preferred_supplier and last purchase' },
    { method: 'GET', path: '/api/inventory/stock/:sku', returns: 'one item: stock per location, FIFO layers, suppliers[], last purchase' },
    { method: 'GET', path: '/api/inventory/items', params: 'q, active, track_stock, limit, cursor', returns: 'item register (sku, name, Woo ids)' },
    { method: 'GET', path: '/api/inventory/movements', params: 'sku, skus, type, kind, location, ref_type, ref_id, from, to, q, limit, cursor, format=csv', returns: 'the full movement journal' },
    { method: 'GET', path: '/api/inventory/purchase-orders', params: 'status, supplier_id, q, from, to', returns: 'purchase orders' },
    { method: 'GET', path: '/api/inventory/purchase-orders/:id', returns: 'one PO with lines (qty in units, packs × pack_qty when ordered in packs) and receipts' },
    { method: 'GET', path: '/api/inventory/valuation', returns: 'stock value' },
    { method: 'GET', path: '/api/inventory/reports/cogs', params: 'from, to', returns: 'cost of goods sold' },
    { method: 'GET', path: '/api/inventory/month-close', returns: 'end-of-month reports: one row per closed month (total_qty, total_value, sku_count, delta_value vs the month before, backdated_movements) + missing months' },
    { method: 'GET', path: '/api/inventory/month-close/:period', params: 'period=YYYY-MM, by=sku|location, location, q, format=csv',
      returns: 'qty and value per SKU frozen at the end of the month, with prev_qty/prev_value/delta vs the month before; older/newer for paging' },
    { method: 'GET', path: '/api/inventory/reports/stock-as-of', params: 'at=YYYY-MM-DD|ISO, by, location, q, format=csv', returns: 'qty and FIFO value per SKU as at any point in time, rebuilt from the ledger (not frozen)' },
  ],
  write: [
    { method: 'POST', path: '/api/inventory/month-close', body: '{ period: "YYYY-MM", recalculate?: true } | { all_missing: true }', returns: 'close a completed month (or every missing one); recalculate replaces a close and keeps the old totals in history' },
    { method: 'POST', path: '/api/inventory/suppliers/:supplier/match-lines', body: '{ lines: [{ supplier_sku?, gtin?, description?, qty, net_amount? }] }', returns: 'invoice preview (no writes): sku per line, units, unit cost, ready-made po_line; unmatched lines need a sku once' },
    { method: 'POST', path: '/api/inventory/purchase-orders', body: '{ supplier_id, supplier_ref?, lines: [{ sku, qty, unit_cost } | { sku|supplier_sku|gtin, packs, pack_qty?, pack_price }] }', returns: 'the PO (draft)' },
    { method: 'POST', path: '/api/inventory/items/:sku/suppliers', body: '{ supplier, supplier_sku?, pack_qty?, pack_name?, pack_gtin?, preferred? }', returns: 'link an item to a supplier' },
  ],
  kinds: { innkjop: 'purchase_receipt, opening_balance', salg: 'sale, sale_return', justering: 'adjustment_in, adjustment_out, write_off', flytting: 'transfer_in, transfer_out', reversering: 'reversal' },
  summary_fields: {
    sold_net: 'units sold minus units returned in the period',
    received: 'units received on purchase orders (+ opening balance)',
    adjusted: 'net units from adjustments and write-offs (negative = removed)',
    net_change: 'net change of stock in the period (all movements)',
    cogs: 'cost of goods sold in NOK (sales minus returns)',
  },
  recipes: [
    { ask: 'Which products do we buy from Nestlé, and how are they selling?', call: 'GET /api/inventory/suppliers/Nestl%C3%A9%20Norge%20AS/items?from=2026-09-01' },
    { ask: 'What has happened to one product?', call: 'GET /api/inventory/items/LK-DRY-DSV/movements?from=2026-01-01' },
    { ask: 'Everything received from a supplier last month', call: 'GET /api/inventory/suppliers/<supplier>/movements?kind=innkjop&from=2026-09-01&to=2026-10-01' },
    { ask: 'What was the stock worth at the end of September?', call: 'GET /api/inventory/month-close/2026-09' },
    { ask: 'Enter a supplier invoice', call: '1) GET /suppliers/<supplier> and follow rules[]  2) POST /suppliers/<supplier>/match-lines  3) POST /purchase-orders with the matched po_line[]s' },
  ],
};

export function guideMarkdown(g = GUIDE) {
  const ep = (e) => `- \`${e.method} ${e.path}\`${e.params ? ` — params: ${e.params}` : ''}${e.body ? ` — body: \`${e.body}\`` : ''}\n  → ${e.returns}`;
  return [
    `# ${g.name} v${g.version}`, '', g.about, '',
    '## Auth', `- ${g.auth.header}`, `- ${g.auth.attribution}`, `- ${g.auth.note}`, '',
    '## Conventions', ...g.conventions.map((c) => `- ${c}`), '',
    '## Read', ...g.read.map(ep), '',
    '## Write', ...g.write.map(ep), '',
    '## Movement kinds', ...Object.entries(g.kinds).map(([k, v]) => `- \`${k}\`: ${v}`), '',
    '## Summary fields', ...Object.entries(g.summary_fields).map(([k, v]) => `- \`${k}\`: ${v}`), '',
    '## Recipes', ...g.recipes.map((r) => `- ${r.ask}\n  \`${r.call}\``), '',
  ].join('\n');
}

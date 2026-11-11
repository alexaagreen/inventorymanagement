// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Machine-readable guide for AI agents and scripts: GET /api/inventory/guide (JSON) or
// GET /api/inventory/guide?format=md (Markdown). Also served at GET /api/inventory. Keep it short, concrete and in sync with the routes.

export const GUIDE = {
  name: 'inventory-ledger API',
  version: '0.12.0',
  guide: 'GET /api/inventory/guide (JSON) or /api/inventory/guide?format=md',
  about: 'FIFO stock ledger. The ledger is master for stock; WooCommerce is master for products. All amounts are NOK unless a currency is given. Quantities are in the units we stock and sell.',
  auth: {
    header: 'Authorization: Bearer <INVENTORY_API_KEY>',
    attribution: 'Send x-inventory-by: <your name, e.g. grokbot> so writes are attributed to you.',
    note: 'Reads are safe. Writes (POST/PATCH) change stock or documents — preview first where a preview exists.',
  },
  conventions: [
    'Lists return { data, next_cursor }. Pass cursor=<next_cursor> for the next page; limit ≤ 500.',
    'format=csv | xlsx | pdf on list/report endpoints downloads the whole selection: csv = field keys + raw values (semicolon, decimal comma) for machines; xlsx/pdf = labelled report with filters and totals for people (lang=nb|en).',
    'Dates: ISO 8601. Periods are [from, to); movement summaries default to the last 90 days.',
    'A supplier can be addressed by uuid, code or name (case-insensitive, URL-encoded) wherever :supplier appears.',
    'Errors: { error: { code, message, details } } with HTTP 400/404/409/422.',
  ],
  read: [
    { method: 'GET', path: '/api/inventory/suppliers', params: 'q, active, limit, cursor', returns: 'suppliers with item_count, preferred_count, open_po_count, last_receipt_at, order_unit, rules[]' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier', returns: 'one supplier: contact data, rules[] (read them before entering anything), order_unit (unit | pack), items[], purchase_orders[]' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier/items', params: 'from, to, q, include_inactive=1, format=csv|xlsx|pdf',
      returns: 'every product bought from the supplier with stock (on_hand, available, on_order, avg_cost, stock_value), the link (supplier_sku, pack_qty, pack_gtin, last_unit_cost, last_purchase_at) and period_summary { sold_net, received, adjusted, net_change, cogs, movements, last_movement_at }' },
    { method: 'GET', path: '/api/inventory/suppliers/:supplier/movements', params: 'from, to, type, kind, location, limit, cursor, format=csv|xlsx|pdf', returns: 'movements of all the supplier\'s products, newest first' },
    { method: 'GET', path: '/api/inventory/items/:sku/movements', params: 'from, to, type, kind, location, include_reversed, limit, cursor, format=csv|xlsx|pdf',
      returns: '{ item (stock + suppliers[]), period, summary, data: movements newest first, next_cursor }' },
    { method: 'GET', path: '/api/inventory/stock', params: 'q, sku, skus=A,B, supplier_id, below_reorder=1, negative=1, no_supplier=1, location, limit, cursor, format=csv|xlsx|pdf', returns: 'stock per item incl. preferred_supplier and last purchase' },
    { method: 'GET', path: '/api/inventory/stock/:sku', returns: 'one item: stock per location, FIFO layers, suppliers[], last purchase' },
    { method: 'GET', path: '/api/inventory/items', params: 'q, active, track_stock, limit, cursor', returns: 'item register (sku, name, Woo ids)' },
    { method: 'GET', path: '/api/inventory/movements', params: 'sku, skus, type, kind, location, ref_type, ref_id, from, to, q, limit, cursor, format=csv|xlsx|pdf', returns: 'the full movement journal' },
    { method: 'GET', path: '/api/inventory/purchase-orders', params: 'status, supplier_id, q, from, to', returns: 'purchase orders' },
    { method: 'GET', path: '/api/inventory/purchase-orders/:id', returns: 'one PO with lines (qty in units, packs × pack_qty when ordered in packs) and receipts' },
    { method: 'GET', path: '/api/inventory/valuation', returns: 'stock value' },
    { method: 'GET', path: '/api/inventory/reports/cogs', params: 'from, to', returns: 'cost of goods sold' },
    { method: 'GET', path: '/api/inventory/reports/sale-costs', params: 'from, to (on sold_at), source, order_id, order_ids=1,2, sku, skus, location, estimated=1, changed_since, limit, cursor, format=csv|xlsx|pdf',
      returns: 'cost per sold order line: source (woo_order | manual_sale), order_id, line_id (Woo line_item id), qty_sold, qty_returned, qty_net, cogs, unit_cogs, cost_estimated, last_cost_change_at + totals. Join your revenue lines on (source, order_id, line_id) to get margin; cogs is always the current cost (estimates and landed cost are written back)' },
    { method: 'GET', path: '/api/inventory/reports/sale-sources', params: 'from, to, group_by=supplier|po|receipt|origin|sku, source, order_id, sku, skus, supplier_id, po_id, receipt_id, origin, location, limit, cursor, format=csv|xlsx|pdf',
      returns: 'where the cost of what was sold came from: one row per sale × consumed FIFO layer with origin (purchase | opening_balance | adjustment | sale_return | estimated), receipt_number, po_number, supplier_name, po_currency, po_unit_cost, fx_rate, landed_cost_per_unit, days_in_stock — or summed per group_by (qty, cost, unit_cost, avg_days_in_stock, orders)' },
    { method: 'GET', path: '/api/inventory/landed-costs', params: 'status=posted|reversed, receipt_id, po_id, from, to, q, limit, cursor, format=csv|xlsx|pdf', returns: 'freight/duty/fees allocated to goods receipts: amount, method, to_stock, to_cogs, to_other, receipts, po_numbers' },
    { method: 'GET', path: '/api/inventory/landed-costs/:id', returns: 'one landed cost with lines per receipt line: unit_delta, unit_cost_before/after, qty_in_stock, qty_sold, to_stock, to_cogs' },
    { method: 'GET', path: '/api/inventory/month-close', returns: 'end-of-month reports: one row per closed month (total_qty, total_value, sku_count, delta_value vs the month before, backdated_movements) + missing months' },
    { method: 'GET', path: '/api/inventory/month-close/:period', params: 'period=YYYY-MM, by=sku|location, location, q, format=csv|xlsx|pdf',
      returns: 'qty and value per SKU frozen at the end of the month, with prev_qty/prev_value/delta vs the month before; older/newer for paging' },
    { method: 'GET', path: '/api/inventory/reports/stock-as-of', params: 'at=YYYY-MM-DD|ISO, by, location, q, format=csv|xlsx|pdf', returns: 'qty and FIFO value per SKU as at any point in time, rebuilt from the ledger (not frozen)' },
  ],
  write: [
    { method: 'POST', path: '/api/inventory/landed-costs/preview', body: '{ amount, currency?, fx_rate?, method?: "value"|"qty"|"manual", receipts?: [id|number], po?: id|number, lines?: [{ receipt, sku, amount }] }', returns: 'no writes: the split per receipt line and how much goes to stock value (to_stock), COGS of units already sold (to_cogs) and write-offs (to_other)' },
    { method: 'POST', path: '/api/inventory/landed-costs', body: '{ amount, currency?, fx_rate?, method?, description?, vendor?, invoice_ref?, occurred_at?, receipts?: [id|number], po?: id|number, lines?: [{ receipt, sku, amount }] }',
      returns: 'allocates a freight/duty/fee invoice to goods receipts (default: by goods value). Raises the unit cost of what is in stock, corrects COGS of what is sold (cogs_correction reason landed_cost). Amount is ex. VAT. fx_rate is required when currency is not NOK' },
    { method: 'POST', path: '/api/inventory/landed-costs/:id/reverse', body: '{ note? }', returns: 'takes the allocation out again' },
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
    { ask: 'What did order #5001 cost us, and where did the goods come from?', call: 'GET /api/inventory/reports/sale-costs?order_id=<woo order id>  then  GET /api/inventory/reports/sale-sources?order_id=<woo order id>' },
    { ask: 'Which suppliers did last month\'s cost of sales come from?', call: 'GET /api/inventory/reports/sale-sources?group_by=supplier&from=2026-10-01&to=2026-11-01' },
    { ask: 'Which order lines changed cost after they were sold (re-sync margin)?', call: 'GET /api/inventory/reports/sale-costs?changed_since=2026-11-01' },
    { ask: 'Enter a freight or customs invoice for a shipment', call: '1) POST /landed-costs/preview { amount, po: "PO-00012" }  2) check to_stock/to_cogs  3) POST /landed-costs with the same body + description, vendor, invoice_ref' },
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

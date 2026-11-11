// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qDate, requireLandedCostTarget } from '../../../../lib/inventory/handler';
import { listLandedCosts } from '../../../../lib/inventory/queries';
import { rpc } from '../../../../lib/inventory/rpc';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET  /api/inventory/landed-costs?status=posted|reversed&receipt_id=&po_id=&from=&to=&q=&limit=&cursor=&format=csv|xlsx|pdf
// POST /api/inventory/landed-costs
//        { amount, currency?, fx_rate?, method?: value|qty|manual, description?, vendor?, invoice_ref?, occurred_at?, note?,
//          receipts?: [id | number], po?: id | number, lines?: [{ receipt_line_id | receipt + sku, amount }] }
// Freight, duty and fees invoiced after the goods were received (spec §6.10).
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await listLandedCosts({
      status: query.status || null,
      receipt_id: query.receipt_id || null,
      po_id: query.po_id || null,
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      q: query.q || null,
      limit: fmt ? 100000 : qLimit(query.limit),
      cursor: fmt ? null : query.cursor,
    });
    if (fmt) {
      return sendExport(res, fmt, {
        name: 'frakt-og-toll',
        title: { nb: 'Frakt og toll fordelt på varemottak', en: 'Landed cost allocated to receipts' },
        meta: [[{ nb: 'Fra', en: 'From' }, query.from], [{ nb: 'Til (eksklusiv)', en: 'To (exclusive)' }, query.to]],
        columns: cols(['number', 'status', { key: 'occurred_at', nb: 'Dato', en: 'Date', type: 'date' }, 'description', 'vendor', 'invoice_ref',
          'receipts', { key: 'po_numbers', nb: 'Innkjøpsordre', en: 'Purchase orders', type: 'text' },
          'currency', 'amount', 'amount_base', 'method', 'to_stock', 'to_cogs', 'to_other', 'created_by']),
        rows: out.data,
      }, ctx);
    }
    return out;
  },
  POST: async (req, res, { body, by }) => {
    requireLandedCostTarget(body);
    return rpc('create_landed_cost', { ...body, by });
  },
}, { noPush: true });   // costs only — no stock quantity changes

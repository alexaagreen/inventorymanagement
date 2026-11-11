// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qLimit, qList, qDate } from '../../../../lib/inventory/handler';
import { saleSources } from '../../../../lib/inventory/queries';
import { exportFormat, sendExport, cols } from '../../../../lib/inventory/export';

// GET /api/inventory/reports/sale-sources?from=&to=&group_by=supplier|po|receipt|origin|sku&source=&order_id=
//       &sku=&skus=&supplier_id=&po_id=&receipt_id=&origin=&location=&limit=&cursor=&format=csv|xlsx|pdf
// Where the cost of what was sold came from (spec §6.9): one row per sale × consumed FIFO layer,
// traced to goods receipt, purchase order and supplier — or summed per group_by.
const GROUP_LABEL = {
  supplier: { nb: 'Leverandør', en: 'Supplier' }, po: { nb: 'Innkjøpsordre', en: 'Purchase order' },
  receipt: { nb: 'Varemottak', en: 'Receipt' }, origin: { nb: 'Opphav', en: 'Origin' }, sku: { nb: 'SKU', en: 'SKU' },
};
const GROUP_EXTRA = {
  supplier: [], po: ['supplier_name', 'po_currency'],
  receipt: ['po_number', 'supplier_name', { key: 'received_on', nb: 'Mottatt', en: 'Received', type: 'date' }],
  origin: [], sku: ['item_name'],
};

export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const out = await saleSources({
      from: qDate(query.from, 'from'),
      to: qDate(query.to, 'to'),
      group_by: query.group_by || null,
      source: query.source || null,
      order_id: query.order_id || null,
      skus: qList(query.skus) || qList(query.sku),
      supplier_id: query.supplier_id || null,
      po_id: query.po_id || null,
      receipt_id: query.receipt_id || null,
      origin: query.origin || null,
      location: query.location || null,
      limit: qLimit(query.limit),
      cursor: query.cursor,
      all: Boolean(fmt),
    });
    if (fmt) {
      const meta = [
        [{ nb: 'Solgt fra', en: 'Sold from' }, out.from], [{ nb: 'Til (eksklusiv)', en: 'To (exclusive)' }, out.to],
        [{ nb: 'Lokasjon', en: 'Location' }, query.location ? String(query.location).toUpperCase() : null],
      ];
      if (out.group_by) {
        return sendExport(res, fmt, {
          name: `varekost-opphav-${out.group_by}`,
          title: { nb: 'Varekost etter opphav', en: 'Cost of sales by origin' },
          meta,
          columns: cols([{ key: 'key', ...GROUP_LABEL[out.group_by], type: out.group_by === 'supplier' ? 'text' : 'code' },
            ...GROUP_EXTRA[out.group_by], 'qty', 'cost', 'unit_cost', 'avg_days_in_stock', 'orders', 'has_estimates']),
          rows: out.rows,
        }, ctx);
      }
      return sendExport(res, fmt, {
        name: 'varekost-opphav',
        title: { nb: 'Varekost sporet til innkjøp', en: 'Cost of sales traced to purchase' },
        meta,
        columns: cols(['sold_at', 'order_ref', 'source', 'order_id', 'line_id', 'sku', 'item_name', 'location', 'qty', 'unit_cost', 'cost',
          'origin', 'received_at', 'receipt_number', 'po_number', 'supplier_name', 'po_currency', 'po_unit_cost', 'fx_rate',
          'landed_cost_per_unit', 'days_in_stock']),
        rows: out.data,
      }, ctx);
    }
    return out;
  },
});

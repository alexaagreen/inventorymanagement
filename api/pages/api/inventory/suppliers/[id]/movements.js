// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate } from '../../../../../lib/inventory/handler';
import { listMovements, resolveSupplierId, getSupplier } from '../../../../../lib/inventory/queries';
import { exportFormat, sendExport, movementColumns, movementMeta } from '../../../../../lib/inventory/export';

// GET /api/inventory/suppliers/:ref/movements?from=&to=&type=&kind=&location=&include_reversed=0&limit=&cursor=&format=csv|xlsx|pdf
//   (v0.10.0, read-only) Movements of every product linked to this supplier, newest first — same row shape as
//   GET /movements. ref = uuid, code or name. kind = innkjop | salg | justering | flytting | reversering.
export default route({
  GET: async (req, res, ctx) => {
    const { query } = ctx;
    const fmt = exportFormat(query);
    const supplier_id = await resolveSupplierId(query.id);
    const out = await listMovements({
      supplier_id,
      types: qList(query.type), kinds: qList(query.kind), location: query.location || null,
      from: qDate(query.from, 'from'), to: qDate(query.to, 'to'),
      include_reversed: qBool(query.include_reversed) ?? false,
      limit: qLimit(query.limit), cursor: query.cursor, all: Boolean(fmt),
    });
    if (fmt) {
      const s = await getSupplier(supplier_id);
      return sendExport(res, fmt, {
        name: `supplier-movements-${s?.code || s?.name || 'supplier'}`,
        title: { nb: `Bevegelser – ${s?.name || 'leverandør'}`, en: `Movements – ${s?.name || 'supplier'}` },
        meta: movementMeta(query), columns: movementColumns(), csvColumns: 'all', rows: out.data,
      }, ctx);
    }
    return { supplier_id, ...out };
  },
});

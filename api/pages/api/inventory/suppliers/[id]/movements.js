// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, qBool, qLimit, qList, qDate, isCsv } from '../../../../../lib/inventory/handler';
import { listMovements, resolveSupplierId } from '../../../../../lib/inventory/queries';
import { sendCsv } from '../../../../../lib/inventory/csv';

// GET /api/inventory/suppliers/:ref/movements?from=&to=&type=&kind=&location=&include_reversed=0&limit=&cursor=&format=csv
//   (v0.10.0, read-only) Movements of every product linked to this supplier, newest first — same row shape as
//   GET /movements. ref = uuid, code or name. kind = innkjop | salg | justering | flytting | reversering.
export default route({
  GET: async (req, res, { query }) => {
    const csv = isCsv(query);
    const supplier_id = await resolveSupplierId(query.id);
    const out = await listMovements({
      supplier_id,
      types: qList(query.type), kinds: qList(query.kind), location: query.location || null,
      from: qDate(query.from, 'from'), to: qDate(query.to, 'to'),
      include_reversed: qBool(query.include_reversed) ?? false,
      limit: qLimit(query.limit), cursor: query.cursor, all: csv,
    });
    if (csv) return sendCsv(res, 'supplier-movements.csv', out.data);
    return { supplier_id, ...out };
  },
});

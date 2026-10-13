import { describe, it, expect, beforeAll } from 'vitest';
import { call, db, item } from './helpers';
import suppliers from '../pages/api/inventory/suppliers/index';
import supplier from '../pages/api/inventory/suppliers/[id]';
import matchLines from '../pages/api/inventory/suppliers/[id]/match-lines';
import itemSuppliers from '../pages/api/inventory/items/[sku]/suppliers';
import purchaseOrders from '../pages/api/inventory/purchase-orders/index';

// v0.10.0: supplier rules, order_unit and buying in packs — the Nestlé case.
describe('v0.10.0 supplier rules and packs', () => {
  let sup;
  beforeAll(async () => {
    await item('NP-DRY-25', 8501);   // one 2.5 kg bag
    await item('NP-WET-400', 8502);  // one 400 g can
  });

  it('stores rules and order_unit on the supplier', async () => {
    const c = await call(suppliers, { method: 'POST', body: {
      name: 'Nestlé Test AS', order_unit: 'pack',
      rules: 'Invoice quantities are cases\nUse the EHF net price' } });
    expect(c.status).toBe(201);
    sup = c.body;
    expect(sup.rules).toEqual(['Invoice quantities are cases', 'Use the EHF net price']);
    const g = await call(supplier, { query: { id: sup.id } });
    expect(g.body.order_unit).toBe('pack');
    expect(g.body.rules).toHaveLength(2);
    const list = await call(suppliers, { query: { q: 'nestlé test' } });
    expect(list.body.data[0].rules).toHaveLength(2);
    expect((await call(supplier, { method: 'PATCH', query: { id: sup.id }, body: { order_unit: 'crate' } })).status).toBe(400);
  });

  it('matches invoice lines, creates the PO in packs and learns the links', async () => {
    await call(itemSuppliers, { method: 'POST', query: { sku: 'NP-DRY-25' }, body: { supplier: sup.id, supplier_sku: '12583641' } });
    await call(itemSuppliers, { method: 'POST', query: { sku: 'NP-WET-400' }, body: { supplier: sup.id, pack_gtin: '5056273610571', pack_qty: 6, pack_name: 'case 6 × 400 g' } });
    const lines = [
      { supplier_sku: '000000000012583641', gtin: '5060184241403', description: 'LK DogDry Du/Sal&Ven (4x2,5kg)', qty: 1, net_amount: 620.82 },
      { supplier_sku: '000000000012611991', gtin: '5056273610571', description: 'LK DogWet Lamb Hotpot (6x400g)', qty: 4, net_amount: 545.33 },
      { supplier_sku: '000000000012585046', description: 'LK Adult Dog Duck/Sal (7kg)', qty: 1, net_amount: 363.43 },
    ];
    const m = await call(matchLines, { method: 'POST', query: { id: sup.id }, body: { lines } });
    expect(m.status).toBe(200);
    expect(m.body.matched).toBe(2);
    expect(m.body.rules).toHaveLength(2);
    expect(m.body.lines[0]).toMatchObject({ sku: 'NP-DRY-25', pack_qty: 4, units: 4, pack_qty_source: 'description' });
    expect(m.body.lines[1]).toMatchObject({ sku: 'NP-WET-400', pack_qty: 6, units: 24, pack_qty_source: 'link' });
    expect(m.body.lines[2].matched).toBe(false);

    // The unmatched line fails clearly…
    const bad = await call(purchaseOrders, { method: 'POST', body: { supplier_id: sup.id, lines: [{ supplier_sku: lines[2].supplier_sku, packs: 1, pack_price: 363.43, description: lines[2].description }] } });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('ITEM_NOT_FOUND');
    expect(bad.body.error.details.supplier_sku).toBe('000000000012585046');

    // …the matched ones post as-is.
    const po = await call(purchaseOrders, { method: 'POST', body: { supplier_id: sup.id, supplier_ref: '1368748532',
      lines: m.body.lines.filter((l) => l.matched).map((l) => l.po_line) } });
    expect(po.status).toBe(201);
    expect(po.body.lines.map((l) => [l.sku, Number(l.qty_ordered), Number(l.packs), Number(l.pack_qty), Number(l.unit_cost)])).toEqual([
      ['NP-DRY-25', 4, 1, 4, 155.205],
      ['NP-WET-400', 24, 4, 6, 22.7221],
    ]);
    const [link] = await db(`select x.pack_qty, x.pack_gtin from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'NP-DRY-25'`);
    expect(Number(link.pack_qty)).toBe(4);
    expect(link.pack_gtin).toBe('5060184241403');
    const again = await call(matchLines, { method: 'POST', query: { id: sup.id }, body: { lines: lines.slice(0, 1) } });
    expect(again.body.lines[0].pack_qty_source).toBe('link');
  });
});

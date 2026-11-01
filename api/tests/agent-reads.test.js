import { describe, it, expect, beforeAll } from 'vitest';
import { call, item } from './helpers';
import { rpc } from '../lib/inventory/rpc';
import guide from '../pages/api/inventory/guide';
import supplier from '../pages/api/inventory/suppliers/[id]';
import supplierItems from '../pages/api/inventory/suppliers/[id]/items';
import supplierMovements from '../pages/api/inventory/suppliers/[id]/movements';
import itemMovements from '../pages/api/inventory/items/[sku]/movements';

// v0.10.0: agent-friendly reads — products per supplier and movements per product.
describe('v0.10.0 agent reads', () => {
  let sup;
  beforeAll(async () => {
    await item('AG-1', 8701); await item('AG-2', 8702); await item('AG-OTHER', 8703);
    sup = await rpc('upsert_supplier', { name: 'Agent Foods AS', code: 'AGF', order_unit: 'pack', rules: ['Quantities are cases'] });
    await rpc('set_item_supplier', { sku: 'AG-1', supplier: sup.id, supplier_sku: '0042', pack_qty: 4 });
    await rpc('set_item_supplier', { sku: 'AG-2', supplier: sup.id });
    const po = await rpc('create_purchase_order', { supplier_id: sup.id, supplier_name: sup.name,
      lines: [{ sku: 'AG-1', packs: 3, pack_price: 400 }, { sku: 'AG-2', qty: 5, unit_cost: 20 }, { sku: 'AG-OTHER', qty: 2, unit_cost: 1 }] });
    await rpc('set_purchase_order_status', [po.id, 'sent', 'test']);
    await rpc('receive_purchase_order', [po.id, { by: 'test', lines: [{ sku: 'AG-1', qty: 12 }, { sku: 'AG-2', qty: 5 }, { sku: 'AG-OTHER', qty: 2 }] }]);
    await rpc('apply_woo_order', [{ id: 970001, status: 'processing', line_items: [{ id: 1, product_id: 8701, quantity: 5 }, { id: 2, product_id: 8702, quantity: 1 }] }, 'webhook']);
    await rpc('apply_woo_order', [{ id: 970002, status: 'processing', line_items: [{ id: 1, product_id: 8701, quantity: 2 }] }, 'webhook']);
    await rpc('apply_woo_order', [{ id: 970002, status: 'processing', line_items: [{ id: 1, product_id: 8701, quantity: 1 }] }, 'webhook']); // edited 2 → 1
  });

  it('GET /api/inventory explains the API (JSON and Markdown)', async () => {
    const j = await call(guide);
    expect(j.status).toBe(200);
    expect(j.body.auth.header).toMatch(/Bearer/);
    expect(j.body.read.some((e) => e.path === '/api/inventory/items/:sku/movements')).toBe(true);
    const md = await call(guide, { query: { format: 'md' } });
    expect(md.headers['content-type']).toMatch(/markdown/);
    expect(md.body).toMatch(/## Recipes/);
  });

  it('a supplier can be addressed by name or code', async () => {
    expect((await call(supplier, { query: { id: 'agent foods as' } })).body.id).toBe(sup.id);
    expect((await call(supplier, { query: { id: 'AGF' } })).body.rules).toEqual(['Quantities are cases']);
    const p = await call(supplier, { method: 'PATCH', query: { id: 'AGF' }, body: { default_lead_time_days: 3 } });
    expect(p.body.default_lead_time_days).toBe(3);
    expect((await call(supplier, { query: { id: 'Nobody AS' } })).status).toBe(404);
  });

  it('GET /suppliers/:ref/items lists the products with stock and a period summary', async () => {
    const r = await call(supplierItems, { query: { id: 'Agent Foods AS' } });
    expect(r.status).toBe(200);
    expect(r.body.supplier).toMatchObject({ name: 'Agent Foods AS', order_unit: 'pack', rules: ['Quantities are cases'] });
    expect(r.body.data.map((x) => x.sku)).toEqual(['AG-1', 'AG-2', 'AG-OTHER']); // AG-OTHER got linked by the PO
    const a1 = r.body.data[0];
    expect(Number(a1.on_hand)).toBe(12 - 5 - 1);
    expect(Number(a1.pack_qty)).toBe(4);
    expect(a1.supplier_sku).toBe('0042');
    expect(Number(a1.last_unit_cost)).toBe(100);
    expect(Number(a1.period_summary.received)).toBe(12);
    expect(Number(a1.period_summary.sold_net)).toBe(6);
    expect(Number(a1.period_summary.net_change)).toBe(6);
    expect(Number(a1.period_summary.cogs)).toBe(600);
    expect(r.body.data[1].period_summary.sold_net).toBe(1);
    const empty = await call(supplierItems, { query: { id: 'AGF', from: '2020-01-01', to: '2020-02-01' } });
    expect(empty.body.data[0].period_summary.movements).toBe(0);
    const csv = await call(supplierItems, { query: { id: 'AGF', format: 'csv' } });
    expect(csv.body).toMatch(/period_sold_net/);
    expect((await call(supplierItems, { query: { id: 'AGF', from: '2026-02-01', to: '2026-01-01' } })).status).toBe(400);
  });

  it('GET /suppliers/:ref/movements returns movements of the supplier\'s products only', async () => {
    const r = await call(supplierMovements, { query: { id: 'AGF', kind: 'salg' } });
    expect(r.status).toBe(200);
    expect(r.body.data.every((m) => ['AG-1', 'AG-2', 'AG-OTHER'].includes(m.sku))).toBe(true);
    expect(r.body.data.every((m) => ['sale', 'sale_return'].includes(m.type))).toBe(true);
    expect(r.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /items/:sku/movements returns stock, suppliers, a summary and the history', async () => {
    const r = await call(itemMovements, { query: { sku: 'ag-1' } });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ sku: 'AG-1' });
    expect(Number(r.body.item.on_hand)).toBe(6);
    expect(r.body.item.suppliers[0]).toMatchObject({ supplier_name: 'Agent Foods AS', supplier_sku: '0042' });
    expect(Number(r.body.summary.qty_in)).toBe(13);   // 12 received + 1 back from the edited order
    expect(Number(r.body.summary.qty_out)).toBe(7);
    expect(Number(r.body.summary.sold_net)).toBe(6);
    expect(r.body.data[0].type).toBe('sale_return');  // newest first
    expect(r.body.data.at(-1).type).toBe('purchase_receipt');
    const page = await call(itemMovements, { query: { sku: 'AG-1', limit: 2 } });
    expect(page.body.data).toHaveLength(2);
    expect(page.body.next_cursor).toBeTruthy();
    const next = await call(itemMovements, { query: { sku: 'AG-1', limit: 2, cursor: page.body.next_cursor } });
    expect(Number(next.body.data[0].id)).toBeLessThan(Number(page.body.data[1].id));
    expect((await call(itemMovements, { query: { sku: 'NOPE' } })).status).toBe(404);
  });
});

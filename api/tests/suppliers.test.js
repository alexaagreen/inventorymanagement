import { describe, it, expect, beforeAll } from 'vitest';
import { call, item } from './helpers';
import suppliers from '../pages/api/inventory/suppliers/index';
import supplier from '../pages/api/inventory/suppliers/[id]';
import importLinks from '../pages/api/inventory/suppliers/import';
import itemSuppliers from '../pages/api/inventory/items/[sku]/suppliers';
import purchaseOrders from '../pages/api/inventory/purchase-orders/index';
import stock from '../pages/api/inventory/stock/index';
import stockSku from '../pages/api/inventory/stock/[sku]';

describe('v0.7.0 suppliers', () => {
  let sup;
  beforeAll(async () => {
    await item('SUP-1', 8001);
    await item('SUP-2', 8002);
  });

  it('creates, lists, rejects duplicates and updates suppliers', async () => {
    const c = await call(suppliers, { method: 'POST', body: { name: 'Fjell Ski AS', currency: 'nok', email: 'post@fjell.example' } });
    expect(c.status).toBe(201);
    sup = c.body;
    expect(sup.currency).toBe('NOK');
    expect((await call(suppliers, { method: 'POST', body: { name: 'fjell ski as' } })).status).toBe(409);
    const list = await call(suppliers, { query: { q: 'fjell' } });
    expect(list.body.data.map((s) => s.name)).toContain('Fjell Ski AS');
    const p = await call(supplier, { method: 'PATCH', query: { id: sup.id }, body: { default_lead_time_days: 21 } });
    expect(p.body.default_lead_time_days).toBe(21);
    expect((await call(supplier, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
  });

  it('links items, moves the preferred supplier and removes links', async () => {
    let r = await call(itemSuppliers, { method: 'POST', query: { sku: 'SUP-1' }, body: { supplier: sup.id, supplier_sku: 'FJ-1', list_price: 999 } });
    expect(r.status).toBe(201);
    expect(r.body[0]).toMatchObject({ supplier_name: 'Fjell Ski AS', preferred: true, supplier_sku: 'FJ-1', lead_time_days: 21 });
    await call(suppliers, { method: 'POST', body: { name: 'Other Supply' } });
    r = await call(itemSuppliers, { method: 'POST', query: { sku: 'SUP-1' }, body: { supplier: 'Other Supply', preferred: true } });
    expect(r.body.map((x) => [x.supplier_name, x.preferred])).toEqual([['Other Supply', true], ['Fjell Ski AS', false]]);
    expect((await call(itemSuppliers, { method: 'POST', query: { sku: 'SUP-1' }, body: { supplier: 'Nobody' } })).status).toBe(404);
    r = await call(itemSuppliers, { method: 'DELETE', query: { sku: 'SUP-1', supplier: r.body[0].supplier_id } });
    expect(r.body).toHaveLength(1);
    expect(r.body[0].preferred).toBe(true);
  });

  it('PO by supplier_id, last purchase on stock rows and item status, no_supplier filter', async () => {
    const po = await call(purchaseOrders, { method: 'POST', body: { supplier_id: sup.id, currency: 'NOK', lines: [{ sku: 'SUP-1', qty: 3, unit_cost: 950 }] } });
    expect(po.status).toBe(201);
    expect(po.body.supplier_name).toBe('Fjell Ski AS');
    const list = await call(purchaseOrders, { query: { supplier_id: sup.id } });
    expect(list.body.data[0].supplier_uuid).toBe(sup.id);

    const s = await call(stock, { query: { skus: 'SUP-1,SUP-2' } });
    const row1 = s.body.data.find((x) => x.sku === 'SUP-1');
    expect(row1).toMatchObject({ preferred_supplier: 'Fjell Ski AS', supplier_count: 1 });
    const missing = await call(stock, { query: { skus: 'SUP-1,SUP-2', no_supplier: '1' } });
    expect(missing.body.data.map((x) => x.sku)).toEqual(['SUP-2']);
    const st = await call(stockSku, { query: { sku: 'SUP-1' } });
    expect(st.body.suppliers).toHaveLength(1);
    expect(st.body.purchase.preferred_supplier).toBe('Fjell Ski AS');
  });

  it('bulk import: 422 on errors, dry run 200, import 201', async () => {
    const bad = await call(importLinks, { method: 'POST', body: { rows: [{ sku: 'SUP-2', supplier: 'Brand New Co' }] } });
    expect(bad.status).toBe(422);
    const dry = await call(importLinks, { method: 'POST', body: { dry_run: true, create_suppliers: true, rows: [{ sku: 'SUP-2', supplier: 'Brand New Co' }] } });
    expect(dry.status).toBe(200);
    expect(dry.body.new_suppliers).toBe(1);
    const ok = await call(importLinks, { method: 'POST', body: { create_suppliers: true, rows: [{ sku: 'SUP-2', supplier: 'Brand New Co', supplier_sku: 'BN-2' }] } });
    expect(ok.status).toBe(201);
    const r = await call(itemSuppliers, { query: { sku: 'SUP-2' } });
    expect(r.body[0]).toMatchObject({ supplier_name: 'Brand New Co', preferred: true, supplier_sku: 'BN-2' });
  });
});

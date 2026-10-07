import { describe, it, expect, beforeAll } from 'vitest';
import { call, item, db } from './helpers';
import poIndex from '../pages/api/inventory/purchase-orders/index';
import poOne from '../pages/api/inventory/purchase-orders/[id]/index';
import poStatus from '../pages/api/inventory/purchase-orders/[id]/status';
import poReceive from '../pages/api/inventory/purchase-orders/[id]/receive';
import onOrder from '../pages/api/inventory/purchase-orders/on-order';
import receipts from '../pages/api/inventory/receipts/index';
import receiptOne from '../pages/api/inventory/receipts/[id]/index';
import receiptReverse from '../pages/api/inventory/receipts/[id]/reverse';
import adjustments from '../pages/api/inventory/adjustments/index';
import adjOne from '../pages/api/inventory/adjustments/[id]/index';
import adjPreview from '../pages/api/inventory/adjustments/preview';
import adjReverse from '../pages/api/inventory/adjustments/[id]/reverse';
import transfers from '../pages/api/inventory/transfers/index';
import trOne from '../pages/api/inventory/transfers/[id]/index';
import trReverse from '../pages/api/inventory/transfers/[id]/reverse';
import salesReturns from '../pages/api/inventory/sales/returns';
import sales from '../pages/api/inventory/sales/index';
import items from '../pages/api/inventory/items/index';
import itemOne from '../pages/api/inventory/items/[sku]';

describe('purchase orders + receipts', () => {
  let poId;
  beforeAll(async () => { await item('DOC-1', 2001); await item('DOC-2', 2002); });

  it('create → 201 draft, PATCH, list, on-order', async () => {
    const r = await call(poIndex, { method: 'POST', body: { supplier_name: 'Tojiro', currency: 'JPY', fx_rate: 0.071, expected_at: '2026-11-15',
      lines: [{ sku: 'DOC-1', qty: 10, unit_cost: 1500, landed_cost_per_unit: 5 }] } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    poId = r.body.id;
    const p = await call(poOne, { method: 'PATCH', query: { id: poId }, body: { note: 'hei', lines: [{ sku: 'DOC-1', qty: 10, unit_cost: 1500, landed_cost_per_unit: 5 }, { sku: 'DOC-2', qty: 2, unit_cost: 100 }] } });
    expect(p.status).toBe(200);
    expect(p.body.lines).toHaveLength(2);
    const s = await call(poStatus, { method: 'POST', query: { id: poId }, body: { status: 'sent' } });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('sent');
    const list = await call(poIndex, { query: { status: 'sent,partially_received', q: 'tojiro' } });
    expect(list.body.data.map((x) => x.id)).toContain(poId);
    const oo = await call(onOrder, { query: { sku: 'DOC-1' } });
    expect(Number(oo.body.data[0].qty_open)).toBe(10);
  });

  it('receive partial, over-receipt 422, reverse receipt', async () => {
    const over = await call(poReceive, { method: 'POST', query: { id: poId }, body: { lines: [{ sku: 'DOC-1', qty: 11 }] } });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVER_RECEIPT');
    const r = await call(poReceive, { method: 'POST', query: { id: poId }, body: { lines: [{ sku: 'DOC-1', qty: 6 }] } });
    expect(r.status).toBe(201);
    expect(Number(r.body.lines[0].unit_cost_base)).toBe(111.5);
    expect(r.body.purchase_order.status).toBe('partially_received');
    const lst = await call(receipts, { query: { po_id: poId } });
    expect(lst.body.data).toHaveLength(1);
    const one = await call(receiptOne, { query: { id: r.body.id } });
    expect(one.body.number).toMatch(/^GR-/);
    const rev = await call(receiptReverse, { method: 'POST', query: { id: r.body.id }, body: {} });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe('reversed');
    const po = await call(poOne, { query: { id: poId } });
    expect(po.body.status).toBe('sent');
  });

  it('bad ids → 404', async () => {
    expect((await call(poOne, { query: { id: 'nope' } })).status).toBe(404);
    expect((await call(poOne, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
    expect((await call(receiptOne, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
  });

  it('status transition invalid → 422', async () => {
    const r = await call(poStatus, { method: 'POST', query: { id: poId }, body: { status: 'closed' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PO_STATUS_INVALID');
  });
});

describe('adjustments + transfers', () => {
  beforeAll(async () => {
    await item('ADJ-1', 3001);
    await db(`insert into inv.location (code, name) values ('BUTIKK','Butikk') on conflict do nothing`);
    await db(`select inv.post_movement('{"sku":"ADJ-1","type":"opening_balance","qty":3,"unit_cost":100}')`);
    await db(`select inv.post_movement('{"sku":"ADJ-1","type":"opening_balance","qty":1,"unit_cost":140}')`);
  });

  it('preview writes nothing, then create; COST_REQUIRED and INSUFFICIENT_STOCK', async () => {
    const before = (await db('select count(*)::int n from inv.movement'))[0].n;
    const p = await call(adjPreview, { method: 'POST', body: { lines: [{ sku: 'ADJ-1', delta: 2 }] } });
    expect(p.status).toBe(200);
    expect(p.body.preview).toBe(true);
    expect(Number(p.body.lines[0].unit_cost)).toBe(110);
    expect((await db('select count(*)::int n from inv.movement'))[0].n).toBe(before);

    const a = await call(adjustments, { method: 'POST', body: { reason: 'telling', lines: [{ sku: 'ADJ-1', new_qty: 1 }] } });
    expect(a.status).toBe(201);
    expect(Number(a.body.lines[0].qty_delta)).toBe(-3);
    const noReason = await call(adjustments, { method: 'POST', body: { lines: [{ sku: 'ADJ-1', delta: 1 }] } });
    expect(noReason.status).toBe(400);
    const tooMuch = await call(adjustments, { method: 'POST', body: { reason: 'knust', lines: [{ sku: 'ADJ-1', delta: -5 }] } });
    expect(tooMuch.status).toBe(422);

    await item('ADJ-NEW', 3002);
    const noCost = await call(adjustments, { method: 'POST', body: { reason: 'funnet', lines: [{ sku: 'ADJ-NEW', delta: 1 }] } });
    expect(noCost.status).toBe(422);
    expect(noCost.body.error.code).toBe('COST_REQUIRED');

    const list = await call(adjustments, { query: { q: 'ADJ-1' } });
    expect(list.body.data[0].id).toBe(a.body.id);
    expect(Number(list.body.data[0].value_delta)).toBe(-300);
    const one = await call(adjOne, { query: { id: a.body.id } });
    expect(one.body.movements).toHaveLength(1);
    const rev = await call(adjReverse, { method: 'POST', query: { id: a.body.id }, body: {} });
    expect(rev.body.status).toBe('reversed');
  });

  it('Idempotency-Key replays the same response', async () => {
    const body = { reason: 'funnet', lines: [{ sku: 'ADJ-1', delta: 1 }] };
    const a = await call(adjustments, { method: 'POST', body, headers: { 'Idempotency-Key': 'k-123' } });
    const b = await call(adjustments, { method: 'POST', body, headers: { 'Idempotency-Key': 'k-123' } });
    expect(b.status).toBe(a.status);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect((await db(`select count(*)::int n from inv.adjustment where id = $1`, [a.body.id]))[0].n).toBe(1);
  });

  it('transfer + list + reverse', async () => {
    const t = await call(transfers, { method: 'POST', body: { from_location: 'MAIN', to_location: 'BUTIKK', lines: [{ sku: 'ADJ-1', qty: 2 }] } });
    expect(t.status).toBe(201);
    expect(t.body.number).toMatch(/^TR-/);
    const l = await call(transfers, { query: { location: 'BUTIKK' } });
    expect(l.body.data[0].id).toBe(t.body.id);
    expect((await call(trOne, { query: { id: t.body.id } })).body.lines).toHaveLength(1);
    const r = await call(trReverse, { method: 'POST', query: { id: t.body.id }, body: {} });
    expect(r.body.status).toBe('reversed');
    const same = await call(transfers, { method: 'POST', body: { from_location: 'MAIN', to_location: 'MAIN', lines: [{ sku: 'ADJ-1', qty: 1 }] } });
    expect(same.status).toBe(400);
  });

  it('sales returns use sale COGS', async () => {
    await call(sales, { method: 'POST', body: { ref_id: 'B2B-1', lines: [{ sku: 'ADJ-1', qty: 1 }] } });
    const r = await call(salesReturns, { method: 'POST', body: { ref_id: 'B2B-1-R', original_ref_id: 'B2B-1', lines: [{ sku: 'ADJ-1', qty: 1 }] } });
    expect(r.status).toBe(201);
    expect(r.body.movements[0].cost_source).toBe('sale_cogs');
  });
});

describe('items', () => {
  beforeAll(async () => { await item('IT-1', 4001); });
  it('list + patch reorder fields; Woo fields rejected', async () => {
    const l = await call(items, { query: { q: 'IT-' } });
    expect(l.body.data[0].sku).toBe('IT-1');
    const p = await call(itemOne, { method: 'PATCH', query: { sku: 'it-1' }, body: { reorder_point: 5 } });
    expect(p.status).toBe(200);
    expect(Number(p.body.reorder_point)).toBe(5);
    expect(p.body.below_reorder).toBe(true);
    const bad = await call(itemOne, { method: 'PATCH', query: { sku: 'IT-1' }, body: { name: 'x' } });
    expect(bad.status).toBe(400);
  });
});

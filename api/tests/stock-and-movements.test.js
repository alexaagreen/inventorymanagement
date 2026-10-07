import { describe, it, expect, beforeAll } from 'vitest';
import { call, item } from './helpers';
import poIndex from '../pages/api/inventory/purchase-orders/index';
import poStatus from '../pages/api/inventory/purchase-orders/[id]/status';
import poReceive from '../pages/api/inventory/purchase-orders/[id]/receive';
import sales from '../pages/api/inventory/sales/index';
import stockIndex from '../pages/api/inventory/stock/index';
import stockSku from '../pages/api/inventory/stock/[sku]';
import movements from '../pages/api/inventory/movements/index';
import movementOne from '../pages/api/inventory/movements/[id]/index';
import movementReverse from '../pages/api/inventory/movements/[id]/reverse';
import valuation from '../pages/api/inventory/valuation';
import cogs from '../pages/api/inventory/reports/cogs';
import locations from '../pages/api/inventory/locations';

async function receive(sku, qty, cost, at) {
  const po = await call(poIndex, { method: 'POST', body: { supplier_name: 'Test', expected_at: '2026-12-01', lines: [{ sku, qty, unit_cost: cost }] } });
  expect(po.status).toBe(201);
  await call(poStatus, { method: 'POST', query: { id: po.body.id }, body: { status: 'sent' } });
  const r = await call(poReceive, { method: 'POST', query: { id: po.body.id }, body: { received_at: at, lines: [{ sku, qty }] } });
  expect(r.status).toBe(201);
  return r.body;
}

describe('stock + movements', () => {
  beforeAll(async () => {
    await item('SM-1', 1001);
    await item('SM-2', 1002);
    await receive('SM-1', 10, 100, '2026-09-01');
    await receive('SM-1', 5, 120, '2026-09-05');
  });

  it('auth: 401 without credentials', async () => {
    const r = await call(stockIndex, { auth: false });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
  });

  it('405 for wrong method with Allow header', async () => {
    const r = await call(stockSku, { method: 'DELETE', query: { sku: 'SM-1' } });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET');
  });

  it('sale via /sales gives FIFO COGS (T1)', async () => {
    const r = await call(sales, { method: 'POST', body: { ref_id: 'API-S1', lines: [{ sku: 'SM-1', qty: 12 }] } });
    expect(r.status).toBe(201);
    expect(Number(r.body.movements[0].total_cost)).toBe(1240);
    const again = await call(sales, { method: 'POST', body: { ref_id: 'API-S1', lines: [{ sku: 'SM-1', qty: 12 }] } });
    expect(again.body.movements[0].existing).toBe(true);
  });

  it('GET /stock/:sku has status, locations and layers', async () => {
    const r = await call(stockSku, { query: { sku: 'sm-1' } });
    expect(r.status).toBe(200);
    expect(Number(r.body.on_hand)).toBe(3);
    expect(Number(r.body.available)).toBe(3);
    expect(Number(r.body.avg_cost)).toBe(120);
    expect(r.body.locations[0].code).toBe('MAIN');
    expect(r.body.layers).toHaveLength(1);
  });

  it('GET /stock/:sku unknown → 404 ITEM_NOT_FOUND', async () => {
    const r = await call(stockSku, { query: { sku: 'NOPE' } });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('ITEM_NOT_FOUND');
  });

  it('GET /stock with skus and filters', async () => {
    const r = await call(stockIndex, { query: { skus: 'SM-1,SM-2' } });
    expect(r.body.data.map((x) => x.sku)).toEqual(['SM-1', 'SM-2']);
    const loc = await call(stockIndex, { query: { location: 'main', sku: 'SM-1' } });
    expect(loc.body.data[0].location).toBe('MAIN');
    const csv = await call(stockIndex, { query: { format: 'csv', q: 'SM-' } });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.startsWith('﻿sku;name;on_hand')).toBe(true);
    expect(csv.body).toContain('SM-1;SM-1;3');
  });

  it('GET /movements filters, kind, cursor pagination', async () => {
    const all = await call(movements, { query: { sku: 'SM-1', count: '1' } });
    expect(all.body.total).toBe(3);
    const sales1 = await call(movements, { query: { sku: 'SM-1', type: 'sale' } });
    expect(sales1.body.data).toHaveLength(1);
    const kind = await call(movements, { query: { sku: 'SM-1', kind: 'innkjop' } });
    expect(kind.body.data.every((m) => m.kind === 'innkjop')).toBe(true);
    const p1 = await call(movements, { query: { sku: 'SM-1', limit: '2' } });
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await call(movements, { query: { sku: 'SM-1', limit: '2', cursor: p1.body.next_cursor } });
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    const ids = [...p1.body.data, ...p2.body.data].map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
    const bad = await call(movements, { query: { from: 'not-a-date' } });
    expect(bad.status).toBe(400);
  });

  it('GET /movements/:id + reverse', async () => {
    const list = await call(movements, { query: { sku: 'SM-1', type: 'sale' } });
    const id = list.body.data[0].id;
    const one = await call(movementOne, { query: { id: String(id) } });
    expect(one.body.consumptions).toHaveLength(2);
    expect(one.body.cogs_corrections).toEqual([]);
    const rev = await call(movementReverse, { method: 'POST', query: { id: String(id) }, body: { note: 'feil' } });
    expect(rev.status).toBe(201);
    expect(rev.body.type).toBe('reversal');
    const twice = await call(movementReverse, { method: 'POST', query: { id: String(id) }, body: {} });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_REVERSED');
    // reverserte skjules som default
    const after = await call(movements, { query: { sku: 'SM-1', type: 'sale' } });
    expect(after.body.data).toHaveLength(0);
    const incl = await call(movements, { query: { sku: 'SM-1', include_reversed: '1' } });
    expect(incl.body.data.length).toBe(4);
    const nf = await call(movementOne, { query: { id: '99999999' } });
    expect(nf.status).toBe(404);
  });

  it('POST /movements raw + validation', async () => {
    const ok = await call(movements, { method: 'POST', body: { sku: 'SM-2', type: 'opening_balance', qty: 4, unit_cost: 50, ref_type: 'opening_balance', ref_id: 'SM-2:MAIN' } });
    expect(ok.status).toBe(201);
    expect(ok.body.created_by).toBe('api-key');
    const neg = await call(movements, { method: 'POST', body: { sku: 'SM-2', type: 'adjustment_out', qty: -10 } });
    expect(neg.status).toBe(422);
    expect(neg.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(Number(neg.body.error.details.on_hand)).toBe(4);
    const missing = await call(movements, { method: 'POST', body: { type: 'sale', qty: -1 } });
    expect(missing.status).toBe(400);
  });

  it('valuation, cogs, locations', async () => {
    const v = await call(valuation);
    const mine = v.body.rows.filter((r) => r.sku.startsWith('SM-'));
    expect(mine.reduce((s, r) => s + Number(r.value), 0)).toBe(1600 + 200);
    expect(v.body.total_value).toBeGreaterThanOrEqual(1800);
    const c = await call(cogs, { query: { group_by: 'sku' } });
    expect(c.status).toBe(200);
    expect(c.body.rows.find((r) => r.key === 'SM-1')).toBeUndefined(); // salget ble reversert
    const bad = await call(cogs, { query: { group_by: 'x' } });
    expect(bad.status).toBe(400);
    const l = await call(locations);
    expect(l.body.data[0]).toMatchObject({ code: 'MAIN', is_default: true });
  });
});

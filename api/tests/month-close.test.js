import { describe, it, expect, beforeAll } from 'vitest';
import { call, db, item } from './helpers';
import { rpc } from '../lib/inventory/rpc';
import listRoute from '../pages/api/inventory/month-close/index';
import periodRoute from '../pages/api/inventory/month-close/[period]';
import asOfRoute from '../pages/api/inventory/reports/stock-as-of';
import cronRoute from '../pages/api/inventory/sync/month-close';

// Periods in 2019 so other test files (dated now) do not touch these months.
async function receive(sku, qty, cost, at, location) {
  const po = await rpc('create_purchase_order', { supplier_name: 'MC Test', location, lines: [{ sku, qty, unit_cost: cost }] });
  await rpc('set_purchase_order_status', [po.id, 'sent', 'test']);
  await rpc('receive_purchase_order', [po.id, { by: 'test', received_at: at, location, lines: [{ sku, qty }] }]);
}
const row = (rows, sku) => rows.find((r) => r.sku === sku);

describe('month close (v0.11.0)', () => {
  beforeAll(async () => {
    process.env.INVENTORY_KICK_PUSH = 'off';
    await db(`insert into inv.location (code, name) values ('MCB', 'MC butikk') on conflict do nothing`);
    await item('MCX-1'); await item('MCX-2');
    await receive('MCX-1', 10, 100, '2019-03-05T10:00:00+01:00');
    await rpc('record_sale', { ref_id: 'MCX-S1', occurred_at: '2019-03-20T12:00:00+01:00', lines: [{ sku: 'MCX-1', qty: 4 }] });
    await receive('MCX-2', 3, 20, '2019-04-02T10:00:00+02:00');
    await rpc('create_transfer', { from_location: 'MAIN', to_location: 'MCB', occurred_at: '2019-04-10T10:00:00+02:00', lines: [{ sku: 'MCX-1', qty: 1 }] });
    await rpc('record_sale', { ref_id: 'MCX-S2', occurred_at: '2019-04-15T12:00:00+02:00', lines: [{ sku: 'MCX-1', qty: 2 }] });
  });

  it('closes a month and reads it per SKU with a location breakdown', async () => {
    const r = await call(listRoute, { method: 'POST', body: { period: '2019-03' }, headers: { 'x-inventory-by': 'alex' } });
    expect(r.status).toBe(201);
    expect(r.body.action).toBe('closed');
    expect(r.body.closed_by).toBe('alex');
    const again = await call(listRoute, { method: 'POST', body: { period: '2019-03' } });
    expect(again.status).toBe(200);
    expect(again.body.action).toBe('existing');

    await call(listRoute, { method: 'POST', body: { period: '2019-04' } });
    const d = await call(periodRoute, { query: { period: '2019-04' } });
    expect(d.status).toBe(200);
    expect(d.body.previous_period).toBe('2019-03');
    expect(d.body.older).toBe('2019-03');
    const a = row(d.body.rows, 'MCX-1');
    expect(Number(a.qty)).toBe(4);
    expect(Number(a.value)).toBe(400);
    expect(Number(a.prev_qty)).toBe(6);
    expect(Number(a.delta_value)).toBe(-200);
    expect(Number(a.locations.MAIN.qty)).toBe(3);
    expect(Number(a.locations.MCB.qty)).toBe(1);
    const b = row(d.body.rows, 'MCX-2');
    expect(Number(b.prev_qty)).toBe(0);
    expect(Number(b.value)).toBe(60);

    const byLoc = await call(periodRoute, { query: { period: '2019-04', by: 'location', location: 'mcb' } });
    expect(byLoc.body.rows).toHaveLength(1);
    expect(byLoc.body.rows[0]).toMatchObject({ sku: 'MCX-1', location: 'MCB' });

    const q = await call(periodRoute, { query: { period: '2019-04', q: 'mcx-2' } });
    expect(q.body.rows.map((x) => x.sku)).toEqual(['MCX-2']);

    const csv = await call(periodRoute, { query: { period: '2019-04', format: 'csv' } });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toContain('sku;name;qty;value;unit_cost;prev_qty;prev_value;delta_qty;delta_value');
  });

  it('lists closes with change vs the month before and the missing months', async () => {
    const r = await call(listRoute);
    expect(r.status).toBe(200);
    const apr = r.body.data.find((c) => c.period === '2019-04');
    expect(apr.delta_value).toBe(Number(apr.total_value) - Number(r.body.data.find((c) => c.period === '2019-03').total_value));
    expect(r.body.missing).toContain('2019-05');
    expect(r.body.missing).not.toContain('2019-03');
  });

  it('flags a backdated movement and recalculates on request', async () => {
    await rpc('create_adjustment', { reason: 'telling', occurred_at: '2019-03-28T12:00:00+01:00', lines: [{ sku: 'MCX-1', delta: -1 }] });
    const d = await call(periodRoute, { query: { period: '2019-03' } });
    expect(d.body.close.backdated_movements).toBe(1);
    const r = await call(listRoute, { method: 'POST', body: { period: '2019-03', recalculate: true } });
    expect(r.status).toBe(200);
    expect(r.body.action).toBe('recalculated');
    expect(r.body.backdated_movements).toBe(0);
    expect(r.body.history).toHaveLength(1);
    const d2 = await call(periodRoute, { query: { period: '2019-03' } });
    expect(Number(row(d2.body.rows, 'MCX-1').qty)).toBe(5);
  });

  it('stock as of a date is rebuilt live; a bare date means end of day', async () => {
    const r = await call(asOfRoute, { query: { at: '2019-03-20', q: 'MCX-1' } });
    expect(r.status).toBe(200);
    expect(Number(row(r.body.rows, 'MCX-1').qty)).toBe(6);
    const before = await call(asOfRoute, { query: { at: '2019-03-20T11:00:00+01:00', q: 'MCX-1' } });
    expect(Number(row(before.body.rows, 'MCX-1').qty)).toBe(10);
  });

  it('validates and 404s', async () => {
    expect((await call(periodRoute, { query: { period: '2019-13' } })).status).toBe(400);
    expect((await call(periodRoute, { query: { period: '2018-01' } })).status).toBe(404);
    const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 7);
    expect((await call(listRoute, { method: 'POST', body: { period: future } })).status).toBe(400);
    expect((await call(asOfRoute, { query: {} })).status).toBe(400);
  });

  it('cron and all_missing close every completed month without a close', async () => {
    const r = await call(listRoute, { method: 'POST', body: { all_missing: true } });
    expect(r.status).toBe(200);
    expect(r.body.closed).toContain('2019-05');
    const cron = await call(cronRoute, { method: 'POST' });
    expect(cron.status).toBe(200);
    expect(cron.body.closed).toEqual([]);
    const list = await call(listRoute);
    expect(list.body.missing).toEqual([]);
  });
});

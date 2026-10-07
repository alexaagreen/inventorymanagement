import { describe, it, expect, beforeAll } from 'vitest';
import { call, item, db } from './helpers';
import items from '../pages/api/inventory/items/index';
import openingBalance from '../pages/api/inventory/opening-balance';
import integrity from '../pages/api/inventory/sync/integrity';
import webhookLog from '../pages/api/inventory/webhooks/log';
import { userMessage } from '../lib/inventory/errors';

describe('v0.5.0 endpoints', () => {
  beforeAll(async () => {
    await item('OB-1', 7001);
    await item('OB-2', 7002);
    await item('XOB-1', 7003);
  });

  it('opening balance: dry run 200, errors 422 with nothing written, import 201, idempotent', async () => {
    const dry = await call(openingBalance, { method: 'POST', body: { dry_run: true, rows: [{ sku: 'OB-1', qty: 5, unit_cost: 40 }] } });
    expect(dry.status).toBe(200);
    expect(dry.body.total_value).toBe(200);
    const bad = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'OB-1', qty: 5, unit_cost: 40 }, { sku: 'NOPE', qty: 1, unit_cost: 1 }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ row: 2, sku: 'NOPE' });
    expect((await db(`select count(*)::int n from inv.movement m join inv.item i on i.id = m.item_id where i.sku = 'OB-1'`))[0].n).toBe(0);
    const ok = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'OB-1', qty: 5, unit_cost: 40 }, { sku: 'OB-2', qty: 1, unit_cost: 10 }] } });
    expect(ok.status).toBe(201);
    expect(ok.body.imported).toBe(2);
    const again = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'OB-1', qty: 5, unit_cost: 40 }] } });
    expect(again.body.existing).toBe(1);
    expect((await call(openingBalance, { method: 'POST', body: {} })).status).toBe(400);
  });

  it('items search returns stock and ranks SKU prefix first', async () => {
    const r = await call(items, { query: { q: 'OB-1' } });
    expect(r.body.data[0].sku).toBe('OB-1');
    expect(Number(r.body.data[0].available)).toBe(5);
    expect(Number(r.body.data[0].avg_cost)).toBe(40);
    expect(r.body.data.map((x) => x.sku)).toContain('XOB-1');
  });

  it('integrity + webhook log', async () => {
    const i = await call(integrity);
    expect(i.body.ok).toBe(true);
    await db(`select inv.log_woo_webhook('order.created', '1', 'error', 'boom')`);
    const l = await call(webhookLog, { query: { result: 'error' } });
    expect(l.body.data[0]).toMatchObject({ topic: 'order.created', result: 'error', message: 'boom' });
  });

  it('userMessage in English and Norwegian', () => {
    const err = { code: 'INSUFFICIENT_STOCK', details: { on_hand: '3', location: 'MAIN', requested: 5 } };
    expect(userMessage(err, 'en')).toBe('Not enough stock (3 on MAIN, tried to take 5)');
    expect(userMessage(err)).toBe('Ikke nok på lager (3 på MAIN, prøvde å ta 5)');
    expect(userMessage({ code: 'COST_REQUIRED', details: { sku: 'A' } }, 'en')).toBe('A has no cost history — enter a unit cost');
    expect(userMessage({ code: 'WHATEVER', message: 'x' }, 'en')).toBe('x');
  });
});

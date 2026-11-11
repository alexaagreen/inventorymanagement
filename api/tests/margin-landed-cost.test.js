import { describe, it, expect, beforeAll } from 'vitest';
import { call, db, item } from './helpers';
import { rpc } from '../lib/inventory/rpc';
import { userMessage } from '../lib/inventory/errors';
import saleCosts from '../pages/api/inventory/reports/sale-costs';
import saleSources from '../pages/api/inventory/reports/sale-sources';
import cogs from '../pages/api/inventory/reports/cogs';
import movement from '../pages/api/inventory/movements/[id]/index';
import landedCosts from '../pages/api/inventory/landed-costs/index';
import landedPreview from '../pages/api/inventory/landed-costs/preview';
import landedCost from '../pages/api/inventory/landed-costs/[id]/index';
import landedReverse from '../pages/api/inventory/landed-costs/[id]/reverse';
import receiptReverse from '../pages/api/inventory/receipts/[id]/reverse';
import guide from '../pages/api/inventory/guide';

// v0.12.0: margin per sale (cost per order line, traced to the purchase) and landed cost allocation.
// Dated 2017 so other test files (dated now) stay out of the period filters.
describe('v0.12.0 margin per sale + landed cost', () => {
  let po; let gr; let sup;
  beforeAll(async () => {
    process.env.INVENTORY_KICK_PUSH = 'off';
    await item('MG-1', 9801); await item('MG-2', 9802);
    sup = await rpc('upsert_supplier', { name: 'Margin Knives KK', code: 'MGK' });
    po = await rpc('create_purchase_order', { supplier_id: sup.id, supplier_name: sup.name, currency: 'JPY', fx_rate: 0.07,
      lines: [{ sku: 'MG-1', qty: 10, unit_cost: 1000 }, { sku: 'MG-2', qty: 10, unit_cost: 3000 }] });
    await rpc('set_purchase_order_status', [po.id, 'sent', 'test']);
    gr = await rpc('receive_purchase_order', [po.id, { by: 'test', received_at: '2017-03-01T10:00:00+01:00',
      lines: [{ sku: 'MG-1', qty: 10 }, { sku: 'MG-2', qty: 10 }] }]);
    await rpc('apply_woo_order', [{ id: 980001, number: '5001', status: 'processing', date_created_gmt: '2017-03-10T10:00:00',
      line_items: [{ id: 11, product_id: 9801, quantity: 4 }, { id: 12, product_id: 9802, quantity: 1 }] }, 'webhook']);
  });

  it('GET /reports/sale-costs: one row per order line with COGS, joinable on (source, order_id, line_id)', async () => {
    const r = await call(saleCosts, { query: { order_id: '980001' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    const a = r.body.data.find((x) => x.line_id === '11');
    expect(a).toMatchObject({ source: 'woo_order', order_id: '980001', sku: 'MG-1', order_ref: '#5001', cost_estimated: false });
    expect(Number(a.qty_net)).toBe(4);
    expect(Number(a.cogs)).toBe(280);            // 4 × 1000 JPY × 0.07
    expect(Number(a.unit_cogs)).toBe(70);
    expect(Number(r.body.totals.cogs)).toBe(490);
    expect(r.body.totals.lines).toBe(2);
    const bySku = await call(saleCosts, { query: { sku: 'MG-2', source: 'woo_order' } });
    expect(bySku.body.data.map((x) => x.line_id)).toEqual(['12']);
    const paged = await call(saleCosts, { query: { order_id: '980001', limit: '1' } });
    expect(paged.body.data).toHaveLength(1);
    const next = await call(saleCosts, { query: { order_id: '980001', limit: '1', cursor: paged.body.next_cursor } });
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].line_id).not.toBe(paged.body.data[0].line_id);
    expect(next.body.next_cursor).toBe(null);
  });

  it('GET /reports/sale-sources: traces the cost to receipt, PO, supplier and exchange rate', async () => {
    const r = await call(saleSources, { query: { order_id: '980001', sku: 'MG-1' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ origin: 'purchase', receipt_number: gr.number, po_number: po.number,
      supplier_name: 'Margin Knives KK', po_currency: 'JPY', line_id: '11' });
    expect(Number(r.body.data[0].po_unit_cost)).toBe(1000);
    expect(Number(r.body.data[0].fx_rate)).toBe(0.07);
    expect(Number(r.body.data[0].days_in_stock)).toBeGreaterThan(8);
    const g = await call(saleSources, { query: { group_by: 'supplier', supplier_id: sup.id } });
    expect(g.body.rows).toHaveLength(1);
    expect(g.body.rows[0].key).toBe('Margin Knives KK');
    expect(Number(g.body.rows[0].cost)).toBe(490);
    expect(Number(g.body.rows[0].qty)).toBe(5);
    expect(g.body.rows[0].orders).toBe(1);
    expect(g.body.total_cost).toBe(490);
    const byPo = await call(saleSources, { query: { group_by: 'po', po_id: po.id } });
    expect(byPo.body.rows[0]).toMatchObject({ key: po.number, supplier_name: 'Margin Knives KK', po_currency: 'JPY' });
    expect((await call(saleSources, { query: { group_by: 'colour' } })).status).toBe(400);
  });

  it('GET /movements/:id shows cost_sources for a sale', async () => {
    const [m] = await db(`select id from inv.movement where ref_type = 'woo_order' and ref_id = '980001' and ref_line = '11'`);
    const r = await call(movement, { query: { id: String(m.id) } });
    expect(r.status).toBe(200);
    expect(r.body.cost_sources).toHaveLength(1);
    expect(r.body.cost_sources[0]).toMatchObject({ origin: 'purchase', po_number: po.number, receipt_number: gr.number });
  });

  it('landed cost: preview, post, list, read — sold units correct COGS, the rest revalues stock', async () => {
    const input = { amount: 400, description: 'Sjøfrakt Niigata–Oslo', vendor: 'DSV', invoice_ref: 'INV-77', receipts: [gr.number] };
    const pv = await call(landedPreview, { method: 'POST', body: input });
    expect(pv.status).toBe(200);
    expect(pv.body.preview).toBe(true);
    expect(Number(pv.body.to_cogs)).toBe(70);       // MG-1: 4 × 10, MG-2: 1 × 30
    expect((await call(landedCosts, { query: { q: 'INV-77' } })).body.data).toHaveLength(0);

    const r = await call(landedCosts, { method: 'POST', body: input, headers: { 'x-inventory-by': 'alex' } });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^LC-/);
    expect(r.body).toMatchObject({ status: 'posted', method: 'value', currency: 'NOK', created_by: 'alex' });
    expect(Number(r.body.to_stock)).toBe(330);      // MG-1: 6 × 10, MG-2: 9 × 30
    expect(Number(r.body.to_cogs)).toBe(70);
    expect(Number(r.body.applied_base)).toBe(400);
    expect(r.body.lines.find((l) => l.sku === 'MG-2')).toMatchObject({ receipt_number: gr.number });
    expect(Number(r.body.lines.find((l) => l.sku === 'MG-2').unit_delta)).toBe(30);

    const costs = await call(saleCosts, { query: { order_id: '980001' } });
    expect(Number(costs.body.totals.cogs)).toBe(560);
    expect(costs.body.data.every((x) => x.last_cost_change_at)).toBe(true);
    const changed = await call(saleCosts, { query: { changed_since: '2020-01-01', order_id: '980001' } });
    expect(changed.body.data).toHaveLength(2);
    const src = await call(saleSources, { query: { order_id: '980001', sku: 'MG-1' } });
    expect(Number(src.body.data[0].landed_cost_per_unit)).toBe(10);
    const [st] = await db(`select value from inv.v_stock_by_location where sku = 'MG-2'`);
    expect(Number(st.value)).toBe(9 * 240);
    // /reports/cogs shows the correction as booked in the period
    const c = await call(cogs, { query: { from: '2017-01-01', to: '2018-01-01' } });
    expect(Number(c.body.rows.find((x) => x.key === 'MG-1').cogs)).toBe(320);

    const list = await call(landedCosts, { query: { receipt_id: gr.id } });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ number: r.body.number, receipts: gr.number, po_numbers: po.number, line_count: 2 });
    expect((await call(landedCosts, { query: { po_id: po.id, status: 'posted' } })).body.data).toHaveLength(1);
    const one = await call(landedCost, { query: { id: r.body.id } });
    expect(one.body.receipts[0]).toMatchObject({ number: gr.number, po_number: po.number });
    expect((await call(landedCost, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);

    // A receipt with landed cost cannot be reversed — 409 with a readable message
    const rev = await call(receiptReverse, { method: 'POST', query: { id: gr.id }, body: {} });
    expect(rev.status).toBe(409);
    expect(rev.body.error.code).toBe('LANDED_COST_POSTED');
    expect(userMessage(rev.body.error)).toContain(r.body.number);

    const back = await call(landedReverse, { method: 'POST', query: { id: r.body.id }, body: { note: 'wrong invoice' } });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'reversed', reverse_note: 'wrong invoice' });
    expect(Number((await call(saleCosts, { query: { order_id: '980001' } })).body.totals.cogs)).toBe(490);
    expect((await call(landedReverse, { method: 'POST', query: { id: r.body.id }, body: {} })).status).toBe(409);
    expect((await rpc('verify_integrity')).ok).toBe(true);
  });

  it('landed cost: manual lines in foreign currency, and input validation', async () => {
    const r = await call(landedCosts, { method: 'POST', body: { currency: 'EUR', fx_rate: 11.5, description: 'Toll',
      lines: [{ receipt: gr.number, sku: 'MG-1', amount: 20 }] } });
    expect(r.status).toBe(201);
    expect(r.body.method).toBe('manual');
    expect(Number(r.body.amount_base)).toBe(230);
    expect(Number(r.body.lines[0].unit_delta)).toBe(23);
    expect((await call(landedCosts, { method: 'POST', body: { amount: 10 } })).status).toBe(400);
    expect((await call(landedCosts, { method: 'POST', body: { receipts: [gr.number] } })).status).toBe(400);
    expect((await call(landedCosts, { method: 'POST', body: { amount: 10, currency: 'USD', receipts: [gr.number] } })).status).toBe(400);
    expect((await call(landedCosts, { method: 'POST', body: { amount: 10, receipts: ['GR-NOPE'] } })).status).toBe(404);
    expect((await call(landedCosts, { method: 'POST', body: { amount: 10, po: 'PO-NOPE' } })).status).toBe(404);
  });

  it('the agent guide lists the new endpoints', async () => {
    const g = (await call(guide)).body;
    expect(g.version).toBe('0.12.0');
    for (const p of ['/api/inventory/reports/sale-costs', '/api/inventory/reports/sale-sources', '/api/inventory/landed-costs']) {
      expect(g.read.some((e) => e.path === p)).toBe(true);
    }
    expect(g.write.some((e) => e.path === '/api/inventory/landed-costs')).toBe(true);
  });
});

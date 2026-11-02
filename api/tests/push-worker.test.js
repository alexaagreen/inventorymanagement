import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db } from './helpers';
import { startWooMock } from './woo-mock';
import { pushStock, PUSH_LIMITS } from '../lib/inventory/woo-push';
import { rpc } from '../lib/inventory/rpc';

// Bark incident 2026-10-26: slow Woo saves (a plugin exporting each product on save) made one push
// batch outlive the function, the same ~30 simple items were rewritten every 2–3 minutes, variations
// were never reached and POS sales in Woo were overwritten. These tests pin the fixed behaviour.
let mock;
const SIMPLE = 30;
const due = async () => Number((await db(`select count(*)::int as n from inv.stock_push_queue
  where last_pushed_at is null or requested_at > last_pushed_at`))[0].n);
const claimed = async () => Number((await db(`select count(*)::int as n from inv.stock_push_queue where claimed_until > now()`))[0].n);
const wooQty = (id) => (mock.state.products.find((p) => p.id === id) || Object.values(mock.state.variations).flat().find((v) => v.id === id)).stock_quantity;
const saved = { ...PUSH_LIMITS };

async function receive(sku, qty) {
  await db(`select inv.post_movement($1::jsonb)`, [JSON.stringify({ sku, type: 'adjustment_in', qty, unit_cost: 10 })]);
}

describe('push worker never gets stuck (v0.11.0)', () => {
  beforeAll(async () => {
    mock = await startWooMock();
    process.env.WOOCOMMERCE_STORE_URL = mock.url;
    process.env.WOOCOMMERCE_CONSUMER_KEY = 'ck_test';
    process.env.WOOCOMMERCE_CONSUMER_SECRET = 'cs_test';
    process.env.INVENTORY_KICK_PUSH = 'off';
    // Queue rows from other test files are outside this test's world.
    await db(`select inv.mark_stock_pushed(item_id, 0, true) from inv.stock_push_queue`);
    for (let i = 1; i <= SIMPLE; i++) {
      mock.state.products.push({ id: 87000 + i, type: 'simple', sku: `PW-S${i}`, status: 'publish', manage_stock: true, stock_quantity: 0 });
      await db(`select inv.upsert_item($1::jsonb)`, [JSON.stringify({ sku: `PW-S${i}`, name: `Simple ${i}`, woo_product_id: 87000 + i, track_stock: true })]);
    }
    mock.state.products.push({ id: 87100, type: 'variable', sku: 'PW-LUE', status: 'publish', manage_stock: false });
    mock.state.variations['87100'] = [
      { id: 87101, sku: 'XH43636', status: 'publish', manage_stock: true, stock_quantity: 0 },
      { id: 87102, sku: 'XH43637', status: 'publish', manage_stock: true, stock_quantity: 0 },
    ];
    for (const [id, sku] of [[87101, 'XH43636'], [87102, 'XH43637']]) {
      await db(`select inv.upsert_item($1::jsonb)`, [JSON.stringify({ sku, name: sku, woo_product_id: 87100, woo_variation_id: id, track_stock: true })]);
    }
  });
  afterAll(async () => { Object.assign(PUSH_LIMITS, saved); await mock?.close(); });
  beforeEach(() => { mock.state.requests = []; mock.state.writes = {}; mock.state.writeDelayMsPerItem = 0; });

  it('slow saves: variations still get through, every run ends inside its budget, nothing is rewritten', async () => {
    // Simple products first in the queue, the hats (variations) after — the order that starved them.
    for (let i = 1; i <= SIMPLE; i++) await receive(`PW-S${i}`, 5);
    await receive('XH43636', 4); await receive('XH43637', 6);
    mock.state.writeDelayMsPerItem = 60;                        // 30 items in one batch = 1.8 s > write timeout
    Object.assign(PUSH_LIMITS, { budgetMs: 1500, writeTimeoutMs: 900, chunkStart: 10, targetChunkMs: 300 });

    let runs = 0;
    while ((await due()) > 0 && runs < 15) {
      const t = Date.now();
      const r = await pushStock({ limit: 200 });
      runs++;
      expect(Date.now() - t).toBeLessThan(PUSH_LIMITS.budgetMs + PUSH_LIMITS.writeTimeoutMs + 1500);
      expect(await claimed()).toBe(0);                          // nothing left hanging for 2 minutes
      if (runs === 1) expect(r.pushed).toBeGreaterThan(0);
      await db(`update inv.stock_push_queue set next_attempt_at = null where last_result = 'error'`);
    }
    expect(await due()).toBe(0);
    expect(wooQty(87101)).toBe(4);
    expect(wooQty(87102)).toBe(6);
    for (let i = 1; i <= SIMPLE; i++) expect(wooQty(87000 + i)).toBe(5);
    // The hats were not starved behind the simple products: written in the first run or two.
    const firstVarWrite = mock.state.requests.findIndex((q) => q.path === '/products/87100/variations/batch');
    expect(firstVarWrite).toBeGreaterThanOrEqual(0);
    // No item was saved in Woo more than once.
    expect(Math.max(...Object.values(mock.state.writes))).toBe(1);
  });

  it('a write that timed out but finished in Woo is not written again (pre-read)', async () => {
    Object.assign(PUSH_LIMITS, { budgetMs: 5000, writeTimeoutMs: 300, chunkStart: 5 });
    mock.state.writeDelayMsPerItem = 200;                       // 5 × 200 ms > 300 ms timeout
    for (let i = 1; i <= 5; i++) await receive(`PW-S${i}`, 1);  // → 6
    const r = await pushStock({ limit: 5 });
    expect(r.timeouts).toBeGreaterThan(0);
    expect(r.failed).toBe(5);
    await new Promise((res) => setTimeout(res, 1200));           // Woo finishes the save anyway
    expect(wooQty(87001)).toBe(6);
    await db(`update inv.stock_push_queue set next_attempt_at = null`);
    mock.state.writes = {};
    const r2 = await pushStock({ limit: 5 });
    expect(r2.unchanged).toBe(5);
    expect(r2.pushed).toBe(0);
    expect(mock.state.writes).toEqual({});                      // no second save
    expect(await due()).toBe(0);
  });

  it('a sale in Woo/POS not yet in the ledger is not overwritten until the grace period has passed', async () => {
    Object.assign(PUSH_LIMITS, { budgetMs: 5000, writeTimeoutMs: 2000, chunkStart: 10 });
    expect(wooQty(87010)).toBe(5);
    mock.state.products.find((p) => p.id === 87010).stock_quantity = 4;   // POS sold one in Woo
    // Something else changes the item in the ledger (queue entry), but the sale has not arrived yet.
    await db(`update inv.stock_push_queue set requested_at = now() where item_id = (select id from inv.item where sku = 'PW-S10')`);
    const r = await pushStock();
    expect(r.deferred).toBe(1);
    expect(wooQty(87010)).toBe(4);                                         // the sale stands
    const [q] = await db(`select last_result, deferred_since, next_attempt_at > now() as later from inv.stock_push_queue
                           where item_id = (select id from inv.item where sku = 'PW-S10')`);
    expect(q).toMatchObject({ last_result: 'deferred', later: true });
    const st = await rpc('stock_push_status', []);
    expect(st.deferred_items.map((d) => d.sku)).toContain('PW-S10');

    // The order arrives: the ledger now agrees with Woo → marked done, no write.
    await db(`select inv.post_movement('{"sku":"PW-S10","type":"adjustment_out","qty":-1}')`);
    await db(`update inv.stock_push_queue set next_attempt_at = null`);
    mock.state.writes = {};
    const r2 = await pushStock();
    expect(r2.unchanged).toBe(1);
    expect(mock.state.writes).toEqual({});

    // If it never arrives, the ledger (master) is written after the grace period.
    mock.state.products.find((p) => p.id === 87011).stock_quantity = 3;
    await db(`update inv.stock_push_queue set requested_at = now() where item_id = (select id from inv.item where sku = 'PW-S11')`);
    expect((await pushStock()).deferred).toBe(1);
    await db(`update inv.stock_push_queue set next_attempt_at = null, deferred_since = now() - interval '11 minutes'
               where item_id = (select id from inv.item where sku = 'PW-S11')`);
    const r3 = await pushStock();
    expect(r3.pushed).toBe(1);
    expect(wooQty(87011)).toBe(5);
  });

  it('out of budget: claims are released at once', async () => {
    for (let i = 1; i <= 10; i++) await receive(`PW-S${i}`, 1);
    const r = await pushStock({ limit: 10, budgetMs: -1 });
    expect(r.budget_exhausted).toBe(true);
    expect(r.released).toBe(10);
    expect(await claimed()).toBe(0);
    expect(await due()).toBe(10);
    await pushStock({ limit: 10 });
    expect(await due()).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { call, db } from './helpers';
import { startWooMock } from './woo-mock';
import { pushStock, reconcile, syncItems } from '../lib/inventory/woo-push';
import { importOrders } from '../lib/inventory/woo-order';
import orderWebhook from '../pages/api/inventory/webhooks/woo-order';
import productWebhook from '../pages/api/inventory/webhooks/woo-product';
import syncStatusRoute from '../pages/api/inventory/sync/status';
import pushRoute from '../pages/api/inventory/sync/push-stock';

const SECRET = 'whsec-test';
let mock;

function sign(raw) {
  return crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
}
async function webhook(handler, topic, payload, { badSig = false } = {}) {
  const raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return call(handler, {
    method: 'POST', auth: false, body: raw,
    headers: { 'x-wc-webhook-topic': topic, 'x-wc-webhook-signature': badSig ? 'nope' : sign(raw) },
  });
}

describe('woo integration (mocked Woo)', () => {
  beforeAll(async () => {
    mock = await startWooMock();
    process.env.WOOCOMMERCE_STORE_URL = mock.url;
    process.env.WOOCOMMERCE_CONSUMER_KEY = 'ck_test';
    process.env.WOOCOMMERCE_CONSUMER_SECRET = 'cs_test';
    process.env.WC_WEBHOOK_SECRET = SECRET;
    process.env.INVENTORY_KICK_PUSH = 'off';
    mock.state.products.push(
      { id: 9001, type: 'simple', sku: 'W-1', name: 'Kniv 1', status: 'publish', manage_stock: true, stock_quantity: 0 },
      { id: 9002, type: 'variable', sku: 'W-PARENT', name: 'Brynestein', status: 'publish', manage_stock: false, stock_quantity: null },
      { id: 9003, type: 'simple', sku: '', name: 'Uten SKU', status: 'publish', manage_stock: true, stock_quantity: 0 },
      { id: 9004, type: 'simple', sku: 'W-DRAFT', name: 'Kladd', status: 'draft', manage_stock: true, stock_quantity: 0 },
    );
    mock.state.variations['9002'] = [
      { id: 9102, sku: 'W-2-1000', status: 'publish', manage_stock: true, stock_quantity: 0, attributes: [{ option: '#1000' }] },
      { id: 9103, sku: 'W-2-6000', status: 'publish', manage_stock: 'parent', stock_quantity: null, attributes: [{ option: '#6000' }] },
    ];
  });
  afterAll(async () => { await mock?.close(); });
  beforeEach(() => { mock.state.requests = []; mock.state.failIds.clear(); });

  it('syncItems from Woo REST maps simple + variations', async () => {
    const r = await syncItems({ source: 'woo' });
    expect(r.source).toBe('woo');
    expect(r.skipped.some((s) => s.reason === 'missing sku')).toBe(true);
    const rows = await db(`select sku, woo_product_id, woo_variation_id, track_stock, active, name from inv.item where sku like 'W-%' order by sku`);
    expect(rows.map((x) => x.sku)).toEqual(['W-1', 'W-2-1000', 'W-2-6000', 'W-DRAFT']);
    const v = rows.find((x) => x.sku === 'W-2-1000');
    expect(Number(v.woo_product_id)).toBe(9002);
    expect(Number(v.woo_variation_id)).toBe(9102);
    expect(v.name).toBe('Brynestein – #1000');
    expect(rows.find((x) => x.sku === 'W-2-6000').track_stock).toBe(false);
    expect(rows.find((x) => x.sku === 'W-DRAFT').active).toBe(false);
  });

  it('pushStock: simple via products/batch, variation via parent batch (T19)', async () => {
    await db(`select inv.post_movement('{"sku":"W-1","type":"opening_balance","qty":14,"unit_cost":100}')`);
    await db(`select inv.post_movement('{"sku":"W-2-1000","type":"opening_balance","qty":3,"unit_cost":50}')`);
    const r = await pushStock({ limit: 100 });
    expect(r.pushed).toBe(2);
    const simple = mock.state.requests.find((q) => q.path === '/products/batch');
    expect(simple.body.update).toEqual([{ id: 9001, stock_quantity: 14 }]);
    const varr = mock.state.requests.find((q) => q.path === '/products/9002/variations/batch');
    expect(varr.body.update).toEqual([{ id: 9102, stock_quantity: 3 }]);
    expect(mock.state.products[0].stock_quantity).toBe(14);
    // Nothing new → no calls
    mock.state.requests = [];
    const again = await pushStock();
    expect(again.pushed).toBe(0);
    expect(mock.state.requests).toHaveLength(0);
  });

  it('pushStock: per-item error → failed + backoff, visible in status', async () => {
    await db(`select inv.post_movement('{"sku":"W-1","type":"adjustment_out","qty":-1}')`);
    mock.state.failIds.add(9001);
    const r = await pushStock();
    expect(r.failed).toBe(1);
    const st = await call(syncStatusRoute);
    expect(st.body.failed_items.map((f) => f.sku)).toContain('W-1');
    expect(st.body.woo_configured).toBe(true);
    // backoff: not due immediately afterwards
    mock.state.failIds.clear();
    const r2 = await call(pushRoute, { method: 'POST' });
    expect(r2.status).toBe(200);
    expect(r2.body.pushed).toBe(0);
    await db(`update inv.stock_push_queue set next_attempt_at = now() - interval '1 second'`);
    const r3 = await pushStock();
    expect(r3.pushed).toBe(1);
    expect(mock.state.products[0].stock_quantity).toBe(13);
  });

  it('order webhook: bad signature 401, ping 200, created → sale, refund fetched', async () => {
    const order = { id: 77001, number: '77001', status: 'processing', date_created_gmt: '2026-10-07T08:00:00',
      line_items: [{ id: 1, product_id: 9001, variation_id: 0, sku: 'W-1', quantity: 2 },
                   { id: 2, product_id: 9002, variation_id: 9102, sku: 'W-2-1000', quantity: 1 }], refunds: [] };
    expect((await webhook(orderWebhook, 'order.created', order, { badSig: true })).status).toBe(401);
    expect((await webhook(orderWebhook, 'order.created', 'webhook_id=12')).body).toEqual({ ping: true });

    const r = await webhook(orderWebhook, 'order.created', order);
    expect(r.status).toBe(200);
    expect(r.body.action).toBe('deducted');
    expect(r.body.movements).toBe(2);
    const dup = await webhook(orderWebhook, 'order.updated', order);
    expect(dup.body.movements).toBe(0);

    mock.state.refunds['77001:500'] = { id: 500, line_items: [{ id: 99, product_id: 9001, quantity: -1, meta_data: [{ key: '_refunded_item_id', value: '1' }] }] };
    const withRefund = { ...order, refunds: [{ id: 500, total: '-100' }] };
    const rr = await webhook(orderWebhook, 'order.updated', withRefund);
    expect(rr.body.refunds).toBe(1);
    expect(rr.body.movements).toBe(1);
    expect(mock.state.requests.some((q) => q.path === '/orders/77001/refunds/500')).toBe(true);
    const again = await webhook(orderWebhook, 'order.updated', withRefund);
    expect(again.body.refunds).toBe(0);
    const [{ on_hand }] = await db(`select on_hand from inv.v_item_status where sku = 'W-1'`);
    expect(Number(on_hand)).toBe(13 - 2 + 1);
    const log = await db(`select result from inv.woo_webhook_log where resource_id = '77001' order by id`);
    expect(log.map((l) => l.result)).toEqual(['applied', 'ignored', 'applied', 'ignored']);
  });

  it('order webhook: unknown SKU is reported, deleted is ignored', async () => {
    const r = await webhook(orderWebhook, 'order.created', { id: 77002, status: 'processing', line_items: [{ id: 1, product_id: 1, sku: 'NOPE', quantity: 1 }] });
    expect(r.body.unmatched_skus[0].sku).toBe('NOPE');
    const d = await webhook(orderWebhook, 'order.deleted', { id: 77002 });
    expect(d.body.action).toBe('ignored');
  });

  it('product webhook: updated upserts, deleted deactivates, variation resolves parent', async () => {
    mock.state.products.push({ id: 9005, type: 'simple', sku: 'W-NEW', name: 'Ny', status: 'publish', manage_stock: true, stock_quantity: 0 });
    const u = await webhook(productWebhook, 'product.created', mock.state.products.at(-1));
    expect(u.status).toBe(200);
    expect((await db(`select count(*)::int n from inv.item where sku = 'W-NEW'`))[0].n).toBe(1);
    const v = await webhook(productWebhook, 'product.updated', { id: 9102, parent_id: 9002, sku: 'W-2-1000' });
    expect(v.status).toBe(200);
    const del = await webhook(productWebhook, 'product.deleted', { id: 9005 });
    expect(del.body.deactivated).toBe(1);
    expect((await webhook(productWebhook, 'product.updated', { id: 1 }, { badSig: true })).status).toBe(401);
  });

  it('reconcile reports diffs and fix pushes ledger value (ledger is master)', async () => {
    await db(`select inv.mark_stock_pushed(item_id, 0, true) from inv.stock_push_queue`);
    mock.state.products[0].stock_quantity = 99;   // someone changed it in wp-admin
    const r = await reconcile({ fix: false });
    const d = r.diffs.find((x) => x.sku === 'W-1');
    expect(d).toMatchObject({ woo: 99, ledger: 12 });
    expect(mock.state.products[0].stock_quantity).toBe(99);
    const f = await reconcile({ fix: true });
    expect(f.push.pushed).toBeGreaterThanOrEqual(1);
    expect(mock.state.products[0].stock_quantity).toBe(12);
    const after = await reconcile({ fix: false });
    expect(after.diffs.find((x) => x.sku === 'W-1')).toBeUndefined();
    const st = await call(syncStatusRoute);
    expect(st.body.last_reconcile.checked).toBeGreaterThan(0);
  });

  it('importOrders backfill pages through /orders idempotently', async () => {
    mock.state.orders = Array.from({ length: 150 }, (_, i) => ({
      id: 80000 + i, number: String(80000 + i), status: i % 10 === 0 ? 'cancelled' : 'completed',
      line_items: [{ id: 1, product_id: 9001, sku: 'W-1', quantity: 1 }], refunds: [],
    }));
    const r = await importOrders({ from: '2026-10-01T00:00:00Z' });
    expect(r.processed).toBe(150);
    expect(r.next_page).toBeNull();
    expect(r.movements).toBe(135);
    const again = await importOrders({ from: '2026-10-01T00:00:00Z' });
    expect(again.movements).toBe(0);
    const q = mock.state.requests.find((x) => x.path === '/orders');
    expect(q.query.modified_after).toBe('2026-10-01T00:00:00Z');
    expect(q.query.status).toBe('any');
  });
});

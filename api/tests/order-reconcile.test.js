import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, db, item } from './helpers';
import { startWooMock } from './woo-mock';
import { rpc } from '../lib/inventory/rpc';
import { reconcileOrders } from '../lib/inventory/order-reconcile';
import runsRoute from '../pages/api/inventory/order-reconcile/index';
import runRoute from '../pages/api/inventory/order-reconcile/[id]';
import issuesRoute from '../pages/api/inventory/order-reconcile/issues/index';
import issueRoute from '../pages/api/inventory/order-reconcile/issues/[id]';
import syncStatusRoute from '../pages/api/inventory/sync/status';

let mock;
const dayAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
const onHand = async (sku) => Number((await db('select on_hand from inv.v_item_status where sku = $1', [sku]))[0].on_hand);

async function receive(sku, qty) {
  const po = await rpc('create_purchase_order', { supplier_name: 'Recon Test', lines: [{ sku, qty, unit_cost: 10 }] });
  await rpc('set_purchase_order_status', [po.id, 'sent', 'test']);
  await rpc('receive_purchase_order', [po.id, { by: 'test', lines: [{ sku, qty }] }]);
}
const line = (id, product_id, quantity, sku) => ({ id, product_id, variation_id: 0, quantity, ...(sku ? { sku } : {}) });

describe('order reconcile (v0.9.0)', () => {
  beforeAll(async () => {
    mock = await startWooMock();
    process.env.WOOCOMMERCE_STORE_URL = mock.url;
    process.env.WOOCOMMERCE_CONSUMER_KEY = 'ck_test';
    process.env.WOOCOMMERCE_CONSUMER_SECRET = 'cs_test';
    process.env.INVENTORY_KICK_PUSH = 'off';
    // Orders from other test files are outside this test's world.
    await db(`update inv.woo_order_sync set last_payload = coalesce(last_payload, '{}') || '{"date_modified_gmt":"2020-01-01T00:00:00"}'`);
    await item('RC-1', 9601); await item('RC-2', 9602);
    await receive('RC-1', 20); await receive('RC-2', 20);

    // What the ledger saw (webhooks) …
    const seen = [
      { id: 90001, number: '90001', status: 'processing', line_items: [line(1, 9601, 2)] },
      { id: 90002, number: '90002', status: 'processing', line_items: [line(1, 9602, 1), line(2, 4242, 3, 'GHOST-RC')] },
      { id: 90003, number: '90003', status: 'completed', line_items: [line(1, 9601, 1)] },
      { id: 90004, number: '90004', status: 'processing', line_items: [line(1, 9602, 2)] },
      { id: 90005, number: '90005', status: 'processing', line_items: [line(1, 9602, 4)] },
    ];
    for (const o of seen) await rpc('apply_woo_order', [{ ...o, date_modified_gmt: dayAgo }, 'webhook']);
    await rpc('apply_woo_refund', [90003, { id: 801, line_items: [{ id: 8011, product_id: 9601, quantity: -1, meta_data: [{ key: '_refunded_item_id', value: '1' }] }] }]);
    await db(`update inv.woo_order_sync set last_payload = last_payload || $1::jsonb where woo_order_id between 90001 and 90005`,
      [JSON.stringify({ date_modified_gmt: dayAgo })]);

    // … and what Woo holds now (missed webhooks): 90001 edited 2 → 3, 90003's refund deleted,
    // 90004 deleted for good, 90005 moved to the trash.
    mock.state.orders = [
      { ...seen[0], line_items: [line(1, 9601, 3)], refunds: [] },
      { ...seen[1], refunds: [] },
      { ...seen[2], refunds: [] },
      { ...seen[4], status: 'trash', refunds: [] },
    ];
  });
  afterAll(async () => { await mock?.close(); });

  it('runs, books what Woo changed, records issues and a log in the DB', async () => {
    expect(await onHand('RC-1')).toBe(20 - 2 - 1 + 1);
    expect(await onHand('RC-2')).toBe(20 - 1 - 2 - 4);

    const r = await call(runsRoute, { method: 'POST', body: { days: 7 }, headers: { 'x-inventory-by': 'alex@test' } });
    expect(r.status).toBe(200);
    const run = r.body;
    expect(run.status).toBe('issues');
    expect(run.trigger).toBe('manual');
    expect(run.orders_checked).toBe(5);      // 3 listed + 2 looked up
    expect(run.missing_checked).toBe(2);
    expect(run.orders_changed).toBe(2);      // 90001 +1, 90005 restored
    expect(run.changes.map((c) => c.order_id).sort()).toEqual([90001, 90005]);
    expect(run.issues_new).toBe(3);
    expect(run.log.length).toBeGreaterThan(3);
    expect(run.log.at(-1).message).toMatch(/^Finished: issues/);

    expect(await onHand('RC-1')).toBe(17);    // 18 − one more sold on 90001
    expect(await onHand('RC-2')).toBe(17);    // 4 back from the trashed order

    const q = mock.state.requests.find((x) => x.path === '/orders');
    expect(q.query.status).toBe('any');
    expect(q.query.modified_after).toMatch(/Z$/);

    const iss = await call(issuesRoute, { query: { status: 'open' } });
    const kinds = Object.fromEntries(iss.body.data.map((x) => [x.kind, x]));
    expect(Object.keys(kinds).sort()).toEqual(['order_missing_in_woo', 'refund_missing_in_woo', 'unmatched_sku']);
    expect(kinds.unmatched_sku).toMatchObject({ woo_order_id: '90002', sku: 'GHOST-RC' });
    expect(Number(kinds.order_missing_in_woo.ledger_qty)).toBe(2);
    expect(kinds.refund_missing_in_woo.ref).toBe('801');
    expect(iss.body.counts.open).toBe(3);

    const detail = await call(runRoute, { query: { id: run.id } });
    expect(detail.body.issues).toHaveLength(3);
    expect(detail.body.log.length).toBe(run.log.length);
    const list = await call(runsRoute, { query: {} });
    expect(list.body.data[0]).toMatchObject({ id: run.id, status: 'issues' });
    expect(list.body.data[0].log).toBeUndefined();

    const st = await call(syncStatusRoute);
    expect(st.body.order_reconcile.open_issues).toBe(3);
    expect(st.body.order_reconcile.last_run.id).toBe(run.id);
  });

  it('second run: idempotent, de-duplicates, auto-resolves what was fixed, honours ignore', async () => {
    const open = (await call(issuesRoute, { query: {} })).body.data;
    const ghost = open.find((x) => x.kind === 'unmatched_sku');
    const ign = await call(issueRoute, { method: 'PATCH', query: { id: ghost.id }, body: { action: 'ignore', note: 'test SKU' } });
    expect(ign.status).toBe(200);
    expect(ign.body.resolution).toBe('ignored');
    expect(ign.body.resolved_by).toBe('api-key');

    // The refund is back in Woo (it was a display glitch); fetch it again
    mock.state.orders[2].refunds = [{ id: 801, total: '-10' }];
    const run = await reconcileOrders({ trigger: 'cron', days: 7 });
    expect(run.trigger).toBe('cron');
    expect(run.movements).toBe(0);
    expect(run.issues_new).toBe(0);
    expect(run.issues_seen).toBe(1);          // only the deleted order
    expect(run.issues_resolved).toBe(1);      // the refund
    expect(run.status).toBe('issues');
    const missing = (await call(issuesRoute, { query: { kind: 'order_missing_in_woo' } })).body.data[0];
    expect(missing.seen_count).toBe(2);
    expect((await call(issuesRoute, { query: { status: 'ignored' } })).body.data).toHaveLength(1);
    expect((await call(issuesRoute, { query: { status: 'resolved' } })).body.data[0].resolution).toBe('auto');
  });

  it('refuses a second concurrent run (409) and validates input', async () => {
    const [{ id }] = await db(`insert into inv.order_reconcile_run (window_from, window_to) values (now() - interval '1 day', now()) returning id`);
    const busy = await call(runsRoute, { method: 'POST', body: {} });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('RECONCILE_RUNNING');
    await db('delete from inv.order_reconcile_run where id = $1', [id]);
    expect((await call(runsRoute, { method: 'POST', body: { days: 90 } })).status).toBe(400);
    expect((await call(issuesRoute, { query: { status: 'nope' } })).status).toBe(400);
    expect((await call(runRoute, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
    expect((await call(issueRoute, { method: 'PATCH', query: { id: '00000000-0000-0000-0000-000000000000' }, body: {} })).status).toBe(404);
  });

  it('a Woo outage ends the run as failed with the error in the log', async () => {
    const url = process.env.WOOCOMMERCE_STORE_URL;
    process.env.WOOCOMMERCE_STORE_URL = 'http://127.0.0.1:1';
    try {
      const run = await reconcileOrders({ days: 1 });
      expect(run.status).toBe('failed');
      expect(run.error).toBeTruthy();
      expect(run.log.some((l) => l.level === 'error')).toBe(true);
    } finally { process.env.WOOCOMMERCE_STORE_URL = url; }
  });
});

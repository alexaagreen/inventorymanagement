import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, db, item } from './helpers';
import { startWooMock } from './woo-mock';
import {
  decideTrackStock, excludedByCategory, parseExcludedSlugs, rootSlugsForProduct,
  syncItems, pushStock,
} from '../lib/inventory/woo-push';
import { wooConfigured, wooGet } from '../lib/inventory/woo';
import { assertCron } from '../lib/inventory/config';
import openingBalance from '../pages/api/inventory/opening-balance';

const ENV_KEYS = [
  'WOOCOMMERCE_STORE_URL', 'WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET',
  'WC_API_URL', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET', 'CRON_SECRET', 'INVENTORY_KICK_PUSH',
];

let mock;
const savedEnv = {};
let priorItems = [];

function fakeRes() {
  return {
    statusCode: 200, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json() { this.headersSent = true; return this; },
  };
}

async function track(sku) {
  const [row] = await db(`select track_stock from inv.item where sku = $1`, [sku]);
  return row?.track_stock;
}

describe('v0.6.0 tracking, opening balance, woo env, cron', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    mock = await startWooMock();
    process.env.WOOCOMMERCE_STORE_URL = mock.url;
    process.env.WOOCOMMERCE_CONSUMER_KEY = 'ck_test';
    process.env.WOOCOMMERCE_CONSUMER_SECRET = 'cs_test';
    process.env.INVENTORY_KICK_PUSH = 'off';
    delete process.env.WC_API_URL;
    delete process.env.WC_CONSUMER_KEY;
    delete process.env.WC_CONSUMER_SECRET;

    priorItems = await db(`select sku, name, woo_product_id, woo_variation_id, track_stock, active from inv.item where woo_product_id is not null`);
    for (const row of priorItems) {
      if (row.woo_variation_id != null) continue;
      mock.state.products.push({
        id: Number(row.woo_product_id), type: 'simple', sku: row.sku, name: row.name,
        status: row.active ? 'publish' : 'draft', manage_stock: row.track_stock === true,
        stock_quantity: 0, categories: [],
      });
    }
    mock.state.categories.push(
      { id: 1, slug: 'utleie', parent: 0 },
      { id: 2, slug: 'kniver', parent: 0 },
      { id: 3, slug: 'utleie-barn', parent: 1 },
    );
    mock.state.products.push(
      { id: 6101, type: 'simple', sku: 'V6-ON', name: 'On', status: 'publish', manage_stock: true, stock_quantity: 0, categories: [] },
      { id: 6102, type: 'simple', sku: 'V6-OFF', name: 'Off', status: 'publish', manage_stock: false, stock_quantity: 0, categories: [] },
      { id: 6103, type: 'simple', sku: 'V6-RENT', name: 'Rent', status: 'publish', manage_stock: true, stock_quantity: 0, categories: [{ id: 1, slug: 'utleie' }] },
      { id: 6104, type: 'simple', sku: 'V6-MIX', name: 'Mix', status: 'publish', manage_stock: false, stock_quantity: 0, categories: [{ id: 1, slug: 'utleie' }, { id: 2, slug: 'kniver' }] },
      { id: 6105, type: 'simple', sku: 'V6-CHILD', name: 'Child', status: 'publish', manage_stock: true, stock_quantity: 0, categories: [{ id: 3, slug: 'utleie-barn' }] },
      { id: 6106, type: 'bundle', sku: 'V6-BND', name: 'Bundle', status: 'publish', manage_stock: true, stock_quantity: 0, categories: [] },
      { id: 6107, type: 'simple', sku: 'V6-BPARENT', name: 'Bundle parent', status: 'publish', manage_stock: true, stock_quantity: 0, categories: [] },
      { id: 6108, type: 'simple', sku: 'V6-COMP', name: 'Component', status: 'publish', manage_stock: false, stock_quantity: 0, categories: [] },
      { id: 6109, type: 'variable', sku: 'V6-VAR', name: 'Variable', status: 'publish', manage_stock: false, stock_quantity: null, categories: [] },
    );
    mock.state.variations['6109'] = [
      { id: 6110, sku: 'V6-VAR-P', status: 'publish', manage_stock: 'parent', stock_quantity: null, attributes: [{ option: 'M' }] },
      { id: 6111, sku: 'V6-VAR-ON', status: 'publish', manage_stock: true, stock_quantity: 0, attributes: [{ option: 'S' }] },
    ];
    await db(`drop table if exists public.bundle_components`);
    await db(`create table public.bundle_components (bundle_product_id bigint, component_product_id bigint)`);
    await db(`insert into public.bundle_components values (6107, 6108)`);
    await db(`update inv.settings set value = 'woo_manage_stock' where key = 'track_stock_mode'`);
    await db(`update inv.settings set value = 'utleie' where key = 'track_exclude_category_slugs'`);
  });

  afterAll(async () => {
    await db(`update inv.settings set value = 'woo_manage_stock' where key = 'track_stock_mode'`);
    await db(`update inv.settings set value = '' where key = 'track_exclude_category_slugs'`);
    for (const row of priorItems) {
      await db(`update inv.item set track_stock = $2, active = $3 where sku = $1`, [row.sku, row.track_stock, row.active]);
    }
    await db(`drop table if exists public.bundle_components`);
    await mock?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('decideTrackStock matches the category and bundle rules', () => {
    const exclude = parseExcludedSlugs(' Utleie , unused ');
    expect(excludedByCategory([], exclude)).toBe(false);
    expect(excludedByCategory(['utleie'], exclude)).toBe(true);
    expect(excludedByCategory(['utleie', 'kniver'], exclude)).toBe(false);
    const cats = new Map([
      [1, { id: 1, slug: 'utleie', parent: 0 }],
      [3, { id: 3, slug: 'utleie-barn', parent: 1 }],
    ]);
    expect(rootSlugsForProduct({ categories: [{ id: 3, slug: 'utleie-barn' }] }, cats)).toEqual(['utleie']);
    expect(decideTrackStock({ mode: 'woo_manage_stock', manageStock: true, rootSlugs: ['utleie'], exclude })).toBe(false);
    expect(decideTrackStock({ mode: 'all', manageStock: false, rootSlugs: ['utleie', 'kniver'], exclude })).toBe(true);
    expect(decideTrackStock({ mode: 'all', manageStock: true, isBundle: true })).toBe(false);
    expect(decideTrackStock({ mode: 'woo_manage_stock', manageStock: 'parent' })).toBe(false);
    expect(decideTrackStock({ mode: 'all', manageStock: 'parent' })).toBe(true);
    expect(decideTrackStock({ mode: 'all', manageStock: false, rootSlugs: [] , exclude })).toBe(true);
  });

  it('syncItems from Woo applies mode, roots and bundles', async () => {
    const woo = await syncItems({ source: 'woo' });
    expect(woo.source).toBe('woo');
    expect(await track('V6-ON')).toBe(true);
    expect(await track('V6-OFF')).toBe(false);
    expect(await track('V6-RENT')).toBe(false);
    expect(await track('V6-MIX')).toBe(false);
    expect(await track('V6-CHILD')).toBe(false);
    expect(await track('V6-BND')).toBe(false);
    expect(await track('V6-BPARENT')).toBe(false);
    expect(await track('V6-COMP')).toBe(false);
    expect(await track('V6-VAR-P')).toBe(false);
    expect(await track('V6-VAR-ON')).toBe(true);
    const parents = await db(`select count(*)::int n from inv.item where sku = 'V6-VAR'`);
    expect(parents[0].n).toBe(0);

    await db(`update inv.settings set value = 'all' where key = 'track_stock_mode'`);
    await syncItems({ source: 'woo' });
    expect(await track('V6-OFF')).toBe(true);
    expect(await track('V6-RENT')).toBe(false);
    expect(await track('V6-MIX')).toBe(true);
    expect(await track('V6-CHILD')).toBe(false);
    expect(await track('V6-BND')).toBe(false);
    expect(await track('V6-BPARENT')).toBe(false);
    expect(await track('V6-COMP')).toBe(true);
    expect(await track('V6-VAR-P')).toBe(true);
    expect(await track('V6-ON')).toBe(true);
  });

  it('push sends manage_stock only when mode is all', async () => {
    await db(`update inv.stock_push_queue set next_attempt_at = now() + interval '2 days'
               where item_id not in (select id from inv.item where sku like 'V6-%')
                 and (last_pushed_at is null or requested_at > last_pushed_at)`);
    await db(`select inv.post_movement('{"sku":"V6-OFF","type":"opening_balance","qty":4,"unit_cost":10}')`);
    await db(`select inv.post_movement('{"sku":"V6-VAR-P","type":"opening_balance","qty":2,"unit_cost":8}')`);
    mock.state.requests = [];
    const pushed = await pushStock({ limit: 100 });
    expect(pushed.pushed).toBeGreaterThanOrEqual(2);
    const simple = mock.state.requests.find((q) => q.path === '/products/batch');
    expect(simple.body.update.find((u) => u.id === 6102)).toEqual({ id: 6102, stock_quantity: 4, manage_stock: true });
    const variation = mock.state.requests.find((q) => q.path === '/products/6109/variations/batch');
    expect(variation.body.update.find((u) => u.id === 6110)).toEqual({ id: 6110, stock_quantity: 2, manage_stock: true });
    expect(mock.state.products.find((p) => p.id === 6102).manage_stock).toBe(true);

    await db(`update inv.settings set value = 'woo_manage_stock' where key = 'track_stock_mode'`);
    await db(`select inv.post_movement('{"sku":"V6-OFF","type":"adjustment_in","qty":1,"unit_cost":10}')`);
    mock.state.requests = [];
    await pushStock({ limit: 100 });
    const again = mock.state.requests.find((q) => q.path === '/products/batch');
    expect(again.body.update.find((u) => u.id === 6102)).toEqual({ id: 6102, stock_quantity: 5 });
    await db(`update inv.stock_push_queue set next_attempt_at = null where next_attempt_at > now() + interval '1 day'`);
    await db(`update inv.settings set value = 'all' where key = 'track_stock_mode'`);
  });

  it('rejects an unrecognized bundle_components shape', async () => {
    await db(`drop table public.bundle_components`);
    await db(`create table public.bundle_components (note text)`);
    await expect(syncItems({ source: 'woo' })).rejects.toThrow(/bundle_product_id/);
    await db(`drop table public.bundle_components`);
    await db(`create table public.bundle_components (bundle_product_id bigint, component_product_id bigint)`);
    await db(`insert into public.bundle_components values (6107, 6108)`);
  });

  it('opening balance accepts empty unit_cost and a decimal comma, and rejects qty 0', async () => {
    await item('V6-OB-NEW');
    await item('V6-OB-COMMA');
    await item('V6-OB-ZERO');
    await db(`insert into inv.location (code, name) values ('V6SHOP', 'V6 shop') on conflict (code) do nothing`);
    const seeded = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'V6-OB-NEW', qty: 2, unit_cost: 40 }] } });
    expect(seeded.status).toBe(201);
    // A second location with no cost of its own falls back to the on-hand average.
    const empty = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'V6-OB-COMMA', qty: '2,5', unit_cost: '' }] } });
    expect(empty.status).toBe(201);
    const [comma] = await db(`select on_hand, value, (select cost_source from inv.movement m where m.ref_id = 'V6-OB-COMMA:MAIN' limit 1) as cost_source
                               from inv.v_stock_by_location where sku = 'V6-OB-COMMA'`);
    expect(Number(comma.on_hand)).toBe(2.5);
    expect(Number(comma.value)).toBe(0);
    expect(comma.cost_source).toBe('unknown');

    const avg = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'V6-OB-NEW', location: 'V6SHOP', qty: 1 }] } });
    expect(avg.status).toBe(201);
    const [shop] = await db(`select value, (select cost_source from inv.movement m where m.ref_id = 'V6-OB-NEW:V6SHOP' limit 1) as cost_source
                              from inv.v_stock_by_location where sku = 'V6-OB-NEW' and location_code = 'V6SHOP'`);
    expect(shop.cost_source).toBe('on_hand_avg_all');
    expect(Number(shop.value)).toBe(40);

    const zero = await call(openingBalance, { method: 'POST', body: { rows: [{ sku: 'V6-OB-ZERO', qty: 0, unit_cost: 5 }] } });
    expect(zero.status).toBe(422);
    expect(zero.body.errors[0].message).toMatch(/qty must be > 0/);
    const [gone] = await db(`select count(*)::int n from inv.movement m join inv.item i on i.id = m.item_id where i.sku = 'V6-OB-ZERO'`);
    expect(gone.n).toBe(0);
  });

  it('reads WC_* when WOOCOMMERCE_* are unset', async () => {
    const keep = {
      url: process.env.WOOCOMMERCE_STORE_URL,
      key: process.env.WOOCOMMERCE_CONSUMER_KEY,
      secret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
    };
    delete process.env.WOOCOMMERCE_STORE_URL;
    delete process.env.WOOCOMMERCE_CONSUMER_KEY;
    delete process.env.WOOCOMMERCE_CONSUMER_SECRET;
    process.env.WC_API_URL = `${mock.url}/wp-json/wc/v3/`;
    process.env.WC_CONSUMER_KEY = 'ck_alias';
    process.env.WC_CONSUMER_SECRET = 'cs_alias';
    try {
      expect(wooConfigured()).toBe(true);
      mock.state.requests = [];
      await wooGet('/products');
      expect(mock.state.requests.some((q) => q.path === '/products')).toBe(true);
    } finally {
      process.env.WOOCOMMERCE_STORE_URL = keep.url;
      process.env.WOOCOMMERCE_CONSUMER_KEY = keep.key;
      process.env.WOOCOMMERCE_CONSUMER_SECRET = keep.secret;
      delete process.env.WC_API_URL;
      delete process.env.WC_CONSUMER_KEY;
      delete process.env.WC_CONSUMER_SECRET;
    }
  });

  it('assertCron accepts the bearer secret and otherwise rejects', async () => {
    process.env.CRON_SECRET = 's3cret';
    const ok = fakeRes();
    expect(await assertCron({ headers: { authorization: 'Bearer s3cret' } }, ok)).toBe(true);
    const bad = fakeRes();
    expect(await assertCron({ headers: { authorization: 'Bearer wrong!' } }, bad)).toBe(false);
    expect(bad.statusCode).toBe(401);
    delete process.env.CRON_SECRET;
    const open = fakeRes();
    expect(await assertCron({ headers: { authorization: 'Bearer s3cret' } }, open)).toBe(false);
    expect(open.statusCode).toBe(401);
  });

  it('schema_version is 0.6.0', async () => {
    const [row] = await db(`select value from inv.settings where key = 'schema_version'`);
    expect(row.value).toBe('0.6.0');
  });
});

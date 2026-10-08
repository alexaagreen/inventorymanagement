// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Ledger → Woo: push available stock (outbox worker), reconcile, and
// Woo → ledger: sync items (products/variations → inv.item).
// The ledger is master: reconcile never writes Woo's quantity back into the ledger.
import { rpc, sql } from './rpc';
import { wooConfigured, wooPost, wooGetAll, WooError } from './woo';
import { inventoryConfig } from './config';

const BATCH = 100;

/** Comma-separated root slugs from inv.settings.track_exclude_category_slugs. */
export function parseExcludedSlugs(csv) {
  return new Set(String(csv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** True when the item has at least one root and every root is excluded. No category → not excluded. */
export function excludedByCategory(rootSlugs, exclude) {
  const roots = [...new Set((rootSlugs || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (!roots.length) return false;
  return roots.every((s) => exclude.has(s));
}

/**
 * track_stock for one product or variation.
 * mode `woo_manage_stock` (default) follows Woo manage_stock === true (`parent` is not tracked).
 * mode `all` tracks every product, except bundles and excluded roots.
 * A product under several roots is tracked when at least one root is not excluded.
 */
export function decideTrackStock({ mode = 'woo_manage_stock', manageStock = false, isBundle = false, rootSlugs = [], exclude = new Set() } = {}) {
  if (isBundle) return false;
  const ex = exclude instanceof Set ? exclude : parseExcludedSlugs(exclude);
  if (excludedByCategory(rootSlugs, ex)) return false;
  if (mode === 'all') return true;
  return manageStock === true;
}

/** Walk Woo categories to the root slug. Without a parent index, the assigned slug is the root. */
export function rootSlugsForProduct(product, categoryById) {
  const out = new Set();
  for (const cat of product?.categories || []) {
    let current = (categoryById && categoryById.get(Number(cat.id))) || cat;
    const seen = new Set();
    while (current?.parent && categoryById?.has(Number(current.parent)) && !seen.has(Number(current.id))) {
      seen.add(Number(current.id));
      current = categoryById.get(Number(current.parent));
    }
    const slug = current?.slug || cat.slug;
    if (slug) out.add(String(slug).toLowerCase());
  }
  return [...out];
}

async function trackingSettings() {
  const rows = await sql(`select key, value from inv.settings where key in ('track_stock_mode', 'track_exclude_category_slugs')`);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    mode: map.track_stock_mode === 'all' ? 'all' : 'woo_manage_stock',
    exclude: parseExcludedSlugs(map.track_exclude_category_slugs),
  };
}

/** Bundle parent ids from public.bundle_components, when that mirror table exists. */
async function bundleProductIds() {
  const [reg] = await sql(`select to_regclass('public.bundle_components') as t`);
  if (!reg?.t) return new Set();
  const cols = await sql(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'bundle_components'`);
  const names = new Set(cols.map((c) => c.column_name));
  let col = null;
  if (names.has('bundle_product_id')) col = 'bundle_product_id';
  else if (names.has('bundle_id')) col = 'bundle_id';
  else if (names.has('product_id') && (names.has('component_product_id') || names.has('component_id'))) col = 'product_id';
  if (!col) {
    const err = new Error('public.bundle_components needs bundle_product_id, bundle_id, or product_id plus a component column');
    err.code = 'VALIDATION';
    throw err;
  }
  const [{ ident }] = await sql(`select quote_ident($1) as ident`, [col]);
  const rows = await sql(`select distinct ${ident}::bigint as id from public.bundle_components where ${ident} is not null`);
  return new Set(rows.map((r) => Number(r.id)));
}

async function categoryIndex() {
  try {
    const cats = await wooGetAll('/products/categories');
    return new Map((cats || []).map((c) => [Number(c.id), c]));
  } catch {
    return new Map();
  }
}

async function wooTrackContext() {
  const settings = await trackingSettings();
  const [bundleIds, categoryById] = await Promise.all([bundleProductIds(), categoryIndex()]);
  return { ...settings, bundleIds, categoryById };
}

function pushFields(id, qty, forceManage) {
  const row = { id, stock_quantity: Number(qty) };
  if (forceManage) row.manage_stock = true;
  return row;
}

function pushEnabledFromConfig() {
  return inventoryConfig?.wooPush !== false;
}

async function pushEnabled() {
  if (!pushEnabledFromConfig() || !wooConfigured()) return false;
  const [row] = await sql(`select inv._setting_bool('woo_push_enabled') as on`);
  return Boolean(row?.on);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function markAll(rows, ok, error) {
  for (const r of rows) {
    await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, ok, ok ? null : String(error || '').slice(0, 1000)]);
  }
}

/** Apply a Woo batch response: { update: [{ id, stock_quantity } | { id, error }] }. */
async function applyBatchResult(rows, result, idKey) {
  const byId = new Map((result?.update || []).map((u) => [String(u.id), u]));
  let pushed = 0; let failed = 0;
  for (const r of rows) {
    const u = byId.get(String(r[idKey]));
    if (u && !u.error) { await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, true, null]); pushed++; }
    else {
      const msg = u?.error ? `${u.error.code}: ${u.error.message}` : 'missing in batch response';
      await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, false, msg]); failed++;
    }
  }
  return { pushed, failed };
}

/**
 * Drain the push queue. Simple products: POST /products/batch.
 * Variations: POST /products/:parent/variations/batch (one call per parent).
 * track_stock_mode `all` also sends manage_stock: true, so Woo starts managing stock.
 */
export async function pushStock({ limit = 100 } = {}) {
  if (!(await pushEnabled())) return { pushed: 0, failed: 0, skipped: 0, disabled: true };
  const due = await rpc('list_stock_push_due', [Math.min(Math.max(limit, 1), 500)]);
  if (!due?.length) return { pushed: 0, failed: 0, skipped: 0 };
  const { mode } = await trackingSettings();
  const forceManage = mode === 'all';

  const simple = due.filter((r) => r.woo_variation_id == null);
  const byParent = new Map();
  for (const r of due.filter((x) => x.woo_variation_id != null)) {
    const k = String(r.woo_product_id);
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }

  let pushed = 0; let failed = 0;
  for (const part of chunk(simple, BATCH)) {
    try {
      const res = await wooPost('/products/batch', { update: part.map((r) => pushFields(r.woo_product_id, r.qty_to_push, forceManage)) });
      const o = await applyBatchResult(part, res, 'woo_product_id');
      pushed += o.pushed; failed += o.failed;
    } catch (err) {
      await markAll(part, false, err.message); failed += part.length;
    }
  }
  for (const [parent, rows] of byParent) {
    for (const part of chunk(rows, BATCH)) {
      try {
        const res = await wooPost(`/products/${parent}/variations/batch`, {
          update: part.map((r) => pushFields(r.woo_variation_id, r.qty_to_push, forceManage)),
        });
        const o = await applyBatchResult(part, res, 'woo_variation_id');
        pushed += o.pushed; failed += o.failed;
      } catch (err) {
        await markAll(part, false, err.message); failed += part.length;
      }
    }
  }
  return { pushed, failed, skipped: 0 };
}

/**
 * Start a push without waiting (after a write). The per-minute cron is the guarantee;
 * this only makes Woo update within seconds in the normal case.
 */
export function kickPush() {
  if (process.env.INVENTORY_KICK_PUSH === 'off') return;
  if (!pushEnabledFromConfig() || !wooConfigured()) return;
  pushStock({ limit: 50 }).catch((err) => console.warn('[inventory] kickPush failed:', err.message));
}

// ── Woo catalog ────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['publish', 'private']);

function variationName(product, v) {
  const attrs = (v.attributes || []).map((a) => a.option).filter(Boolean).join(' / ');
  return attrs ? `${product.name} – ${attrs}` : product.name;
}

/** Woo product (+ variations) → inv.item rows. `ctx` carries track_stock_mode, exclusions, categories and bundles. */
export function mapWooProduct(p, variations = [], ctx = {}) {
  const mode = ctx.mode === 'all' ? 'all' : 'woo_manage_stock';
  const exclude = ctx.exclude instanceof Set ? ctx.exclude : parseExcludedSlugs(ctx.exclude);
  const roots = ctx.rootSlugs || rootSlugsForProduct(p, ctx.categoryById);
  const isBundle = p.type === 'bundle' || Boolean(ctx.bundleIds && ctx.bundleIds.has(Number(p.id)));
  const track = (manageStock) => decideTrackStock({ mode, manageStock, isBundle, rootSlugs: roots, exclude });
  if (p.type === 'variable') {
    return variations.map((v) => ({
      sku: v.sku || null,
      woo_product_id: p.id,
      woo_variation_id: v.id,
      name: variationName(p, v),
      // manage_stock 'parent' means stock is controlled on the parent. In woo_manage_stock mode
      // that variation is not tracked, because it cannot be pushed on its own.
      track_stock: track(v.manage_stock),
      active: ACTIVE_STATUSES.has(p.status) && ACTIVE_STATUSES.has(v.status || 'publish'),
    }));
  }
  return [{
    sku: p.sku || null,
    woo_product_id: p.id,
    woo_variation_id: null,
    name: p.name,
    track_stock: track(p.manage_stock),
    active: ACTIVE_STATUSES.has(p.status),
  }];
}

async function fetchWooCatalog() {
  const products = await wooGetAll('/products', { status: 'any' });
  const out = [];
  for (const p of products) {
    let variations = [];
    if (p.type === 'variable') variations = await wooGetAll(`/products/${p.id}/variations`, { status: 'any' });
    out.push({ product: p, variations });
  }
  return out;
}

/**
 * Sync items. Prefers the shop catalog adapter (inv.upsert_items_from_catalog,
 * reads the Supabase mirror), otherwise Woo REST directly. Both paths use the same
 * track_stock rules (mode, excluded root categories, bundles).
 */
export async function syncItems({ source = 'auto' } = {}) {
  if (source !== 'woo') {
    // The adapter (0091) reads the storefront mirror in this database — use it when the mirror exists.
    const [{ has }] = await sql(`select to_regprocedure('inv.upsert_items_from_catalog()') is not null
                                        and to_regclass('public.products') is not null as has`);
    if (has) return { source: 'catalog_adapter', ...(await rpc('upsert_items_from_catalog', [])) };
    if (source === 'catalog') return { source: 'catalog_adapter', error: 'storefront mirror (public.products) not found in the inventory database' };
  }
  if (!wooConfigured()) throw new WooError(0, 'No catalog adapter and WooCommerce is not configured');
  const ctx = await wooTrackContext();
  const catalog = await fetchWooCatalog();
  const items = catalog.flatMap(({ product, variations }) => mapWooProduct(product, variations, ctx));
  return { source: 'woo', ...(await rpc('upsert_items', { items, deactivate_missing: true })) };
}

/** Upsert one product (webhook product.created/updated). */
export async function upsertWooProduct(product) {
  let variations = [];
  if (product.type === 'variable') variations = await wooGetAll(`/products/${product.id}/variations`, { status: 'any' });
  const ctx = await wooTrackContext();
  const items = mapWooProduct(product, variations, ctx);
  const res = await rpc('upsert_items', { items, deactivate_missing: false });
  // Variations removed from the product → inactive
  if (product.type === 'variable') {
    const keep = variations.map((v) => v.id);
    await sql(
      `update inv.item set active = false
        where woo_product_id = $1 and woo_variation_id is not null and active
          and not (woo_variation_id = any($2::bigint[]))`, [product.id, keep]);
  }
  return res;
}

export async function deactivateWooProduct(productId) {
  const rows = await sql(`update inv.item set active = false where woo_product_id = $1 and active returning sku`, [productId]);
  return { deactivated: rows.length };
}

// ── Reconcile ──────────────────────────────────────────────────────────────

/**
 * Compare Woo stock_quantity with the ledger's available for every tracked item.
 * fix=true enqueues the diffs and pushes. Woo's value is never written into the ledger.
 * In track_stock_mode `all`, a tracked item with manage_stock off is a diff, so fix turns it on.
 */
export async function reconcile({ fix = false } = {}) {
  if (!wooConfigured()) throw new WooError(0, 'WooCommerce is not configured');
  const { mode } = await trackingSettings();
  const catalog = await fetchWooCatalog();
  const woo = new Map();
  for (const { product, variations } of catalog) {
    if (product.type === 'variable') {
      for (const v of variations) woo.set(`${product.id}:${v.id}`, { stock: v.stock_quantity, manage: v.manage_stock === true });
    } else {
      woo.set(`${product.id}:`, { stock: product.stock_quantity, manage: product.manage_stock === true });
    }
  }
  const [{ floor }] = await sql(`select inv._setting_bool('woo_push_floor_zero') as floor`);
  const items = await sql(
    `select sku, woo_product_id, woo_variation_id, available
       from inv.v_item_status
      where track_stock and active and woo_product_id is not null`);

  const diffs = []; const missing_in_woo = [];
  for (const it of items) {
    const w = woo.get(`${it.woo_product_id}:${it.woo_variation_id ?? ''}`);
    const expected = floor ? Math.max(Math.floor(Number(it.available)), 0) : Math.floor(Number(it.available));
    if (!w) { missing_in_woo.push(it.sku); continue; }
    if (mode !== 'all' && !w.manage) continue;
    const qtyDiff = Number(w.stock ?? 0) !== expected;
    const manageOff = mode === 'all' && w.manage !== true;
    if (qtyDiff || manageOff) diffs.push({ sku: it.sku, woo: w.stock, ledger: expected, manage_stock: w.manage === true });
  }

  let push = null;
  if (fix && diffs.length) {
    await rpc('enqueue_stock_push', [diffs.map((d) => d.sku)]);
    push = await pushStock({ limit: 500 });
  }
  const result = {
    at: new Date().toISOString(), checked: items.length, diffs_count: diffs.length,
    diffs: diffs.slice(0, 500), missing_in_woo: missing_in_woo.slice(0, 500), fixed: Boolean(fix), push,
  };
  await sql(
    `insert into inv.settings (key, value) values ('last_reconcile', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify({ at: result.at, checked: result.checked, diffs_count: result.diffs_count, missing_in_woo: missing_in_woo.length, fixed: result.fixed })]);
  return result;
}

export async function syncStatus() {
  const status = await rpc('stock_push_status', []);
  const [row] = await sql(`select value from inv.settings where key = 'last_reconcile'`);
  let last = null;
  try { last = row ? JSON.parse(row.value) : null; } catch { last = null; }
  return { ...status, woo_configured: wooConfigured(), push_enabled: await pushEnabled(), last_reconcile: last };
}

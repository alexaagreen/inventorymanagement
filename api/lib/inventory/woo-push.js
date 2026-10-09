// inventory-ledger v0.7.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Ledger → Woo: push of available stock (outbox worker), reconcile, and
// Woo → ledger: item sync (products/variations → inv.item).
// The ledger is master: reconcile NEVER corrects the ledger from Woo — only the other way round.
import { rpc, sql } from './rpc';
import { wooConfigured, wooPost, wooGetAll, WooError } from './woo';
import { inventoryConfig } from './config';

const BATCH = 100;

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

/** Handle a Woo batch response: { update: [{ id, stock_quantity } | { id, error: {…} }] } */
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
 * Variations: POST /products/:parent/variations/batch (one per parent).
 */
export async function pushStock({ limit = 100 } = {}) {
  if (!(await pushEnabled())) return { pushed: 0, failed: 0, skipped: 0, disabled: true };
  const due = await rpc('list_stock_push_due', [Math.min(Math.max(limit, 1), 500)]);
  if (!due?.length) return { pushed: 0, failed: 0, skipped: 0 };

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
      const res = await wooPost('/products/batch', { update: part.map((r) => ({ id: r.woo_product_id, manage_stock: true, stock_quantity: Number(r.qty_to_push) })) });
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
          update: part.map((r) => ({ id: r.woo_variation_id, manage_stock: true, stock_quantity: Number(r.qty_to_push) })),
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
 * Start a push without waiting (after a write). The every-minute cron is the guarantee;
 * this just makes Woo update within seconds in the normal case.
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

/**
 * Tracking rules (v0.6.0), read from inv.settings — same rules as the storefront adapter (0091):
 *   mode 'woo_manage_stock' → track what Woo manages; 'all' → track everything,
 *   except items whose categories ALL sit under an excluded root slug.
 * Bundles are only detectable in the storefront mirror, not via the Woo REST path.
 */
export async function getTrackRules() {
  const rows = await sql(`select key, value from inv.settings where key in ('track_stock_mode', 'track_exclude_category_slugs')`);
  const get = (k) => rows.find((r) => r.key === k)?.value || '';
  return {
    mode: get('track_stock_mode') === 'all' ? 'all' : 'woo_manage_stock',
    exclude: get('track_exclude_category_slugs').split(',').map((x) => x.trim()).filter(Boolean),
  };
}

let _rootsCache = { at: 0, map: null };
/** Woo category id → root slug, cached 10 minutes. */
async function categoryRoots() {
  if (_rootsCache.map && Date.now() - _rootsCache.at < 10 * 60 * 1000) return _rootsCache.map;
  const cats = await wooGetAll('/products/categories', {});
  const byId = new Map(cats.map((c) => [c.id, c]));
  const map = new Map();
  for (const c of cats) {
    let cur = c; let guard = 0;
    while (cur && cur.parent && byId.has(cur.parent) && guard++ < 20) cur = byId.get(cur.parent);
    map.set(c.id, cur?.slug || c.slug);
  }
  _rootsCache = { at: Date.now(), map };
  return map;
}

function excludedByRoots(product, rules, roots) {
  if (!rules?.exclude?.length || !roots) return false;
  const ids = (product.categories || []).map((c) => c.id);
  if (!ids.length) return false;
  return ids.every((id) => rules.exclude.includes(roots.get(id)));
}

/** Woo product (+ variations) → inv.item rows. */
export function mapWooProduct(p, variations = [], rules = { mode: 'woo_manage_stock', exclude: [] }, roots = null) {
  const excluded = excludedByRoots(p, rules, roots);
  const track = (managed) => (excluded ? false : rules.mode === 'all' ? true : managed === true);
  if (p.type === 'variable') {
    return variations.map((v) => ({
      sku: v.sku || null,
      woo_product_id: p.id,
      woo_variation_id: v.id,
      name: variationName(p, v),
      // manage_stock 'parent' = stock is managed on the parent → not pushable per variation (woo_manage_stock mode)
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
 * Sync items. Prefers the shop's catalog adapter (inv.upsert_items_from_catalog,
 * reads the Supabase mirror), otherwise Woo REST directly.
 */
export async function syncItems({ source = 'auto' } = {}) {
  if (source !== 'woo') {
    // The adapter (0090) reads the storefront mirror in the same database — use it when the mirror exists.
    const [{ has }] = await sql(`select to_regprocedure('inv.upsert_items_from_catalog()') is not null
                                        and to_regclass('public.products') is not null as has`);
    if (has) return { source: 'catalog_adapter', ...(await rpc('upsert_items_from_catalog', [])) };
    if (source === 'catalog') return { source: 'catalog_adapter', error: 'storefront mirror (public.products) not found in the inventory database' };
  }
  if (!wooConfigured()) throw new WooError(0, 'No catalog adapter and WooCommerce is not configured');
  const catalog = await fetchWooCatalog();
  const rules = await getTrackRules();
  const roots = rules.exclude.length ? await categoryRoots() : null;
  const items = catalog.flatMap(({ product, variations }) => mapWooProduct(product, variations, rules, roots));
  return { source: 'woo', ...(await rpc('upsert_items', { items, deactivate_missing: true })) };
}

/** Upsert one product (webhook product.created/updated). */
export async function upsertWooProduct(product) {
  let variations = [];
  if (product.type === 'variable') variations = await wooGetAll(`/products/${product.id}/variations`, { status: 'any' });
  const rules = await getTrackRules();
  const roots = rules.exclude.length ? await categoryRoots() : null;
  const items = mapWooProduct(product, variations, rules, roots);
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
 * Compare Woo stock_quantity with the ledger's available for all tracked items.
 * fix=true enqueues the differences and pushes. The Woo value is never written into the ledger.
 */
export async function reconcile({ fix = false } = {}) {
  if (!wooConfigured()) throw new WooError(0, 'WooCommerce is not configured');
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
    if (!w.manage) continue;
    if (Number(w.stock ?? 0) !== expected) diffs.push({ sku: it.sku, woo: w.stock, ledger: expected });
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

// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Item sync treats draft, pending and private Woo products as active (so they can be put on a
// purchase order; trash stays inactive), and the auto path supplements the storefront mirror with
// those statuses from Woo. Draft and pending stay untracked, so stock is never pushed for them.
// (Upstreamed from bark-internal-web #3.)
//
// Ledger → Woo: push of available stock (outbox worker), reconcile, and
// Woo → ledger: item sync (products/variations → inv.item).
// The ledger is master: reconcile NEVER corrects the ledger from Woo — only the other way round.
import { rpc, sql } from './rpc.js';
import { wooConfigured, wooGetAll, wooRequest, WooError } from './woo.js';
import { inventoryConfig } from './config.js';

// ── Push worker limits (v0.11.0) ─────────────────────────────────────────────
// A run must finish well inside the function limit (cron routes: maxDuration 60 s), so it works
// in a time budget and in chunks that adapt to how fast Woo saves. Env overrides per shop.
const env = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);
export const PUSH_LIMITS = {
  budgetMs: env('INVENTORY_PUSH_BUDGET_MS', 40000),       // stop starting new chunks after this
  writeTimeoutMs: env('INVENTORY_PUSH_WRITE_TIMEOUT_MS', 20000), // one batch write; never retried on timeout
  readTimeoutMs: env('INVENTORY_PUSH_READ_TIMEOUT_MS', 10000),
  chunkStart: env('INVENTORY_PUSH_CHUNK', 10),             // first chunk size; then adapts
  chunkMax: env('INVENTORY_PUSH_CHUNK_MAX', 50),
  targetChunkMs: env('INVENTORY_PUSH_TARGET_CHUNK_MS', 8000), // aim for writes of about this long
};

function pushEnabledFromConfig() {
  return inventoryConfig?.wooPush !== false;
}

async function pushEnabled() {
  if (!pushEnabledFromConfig() || !wooConfigured()) return false;
  const [row] = await sql(`select inv._setting_bool('woo_push_enabled') as on`);
  return Boolean(row?.on);
}

async function markAll(rows, ok, error) {
  for (const r of rows) {
    await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, ok, ok ? null : String(error || '').slice(0, 1000)]);
  }
}

/** Handle a Woo batch response: { update: [{ id, stock_quantity, stock_status, manage_stock, … } | { id, error: {…} }] } */
async function applyBatchResult(rows, result, idKey) {
  const byId = new Map((result?.update || []).map((u) => [String(u.id), u]));
  let pushed = 0; let failed = 0;
  const mirror = [];
  for (const r of rows) {
    const u = byId.get(String(r[idKey]));
    if (u && !u.error) {
      await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, true, null]); pushed++;
      mirror.push({
        id: Number(u.id),
        stock_quantity: typeof u.stock_quantity === 'number' ? u.stock_quantity : Number(r.qty_to_push),
        stock_status: u.stock_status || null,
        manage_stock: typeof u.manage_stock === 'boolean' ? u.manage_stock : true,
      });
    } else {
      const msg = u?.error ? `${u.error.code}: ${u.error.message}` : 'missing in batch response';
      await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, false, msg]); failed++;
    }
  }
  const mirrored = await updateMirror(idKey === 'woo_variation_id' ? 'variations' : 'products', mirror);
  return { pushed, failed, mirrored };
}

/**
 * Write what Woo now holds straight into the storefront mirror (public.products /
 * public.product_variations) so storefronts reading Supabase do not wait for the
 * Woo → Supabase sync. Best effort: a mirror failure never fails the push.
 */
async function updateMirror(kind, rows) {
  if (!rows.length) return 0;
  try {
    const r = await rpc('apply_mirror_stock', { [kind]: rows });
    return Number(r?.[kind] || 0);
  } catch (err) {
    console.warn('[inventory] mirror stock update failed:', err.message);
    return 0;
  }
}

/** Current stock in Woo for a slice (cheap list read — no product save). Map id → { qty, managed } or null on failure. */
async function readWooStock(group, rows) {
  const idKey = group.parent ? 'woo_variation_id' : 'woo_product_id';
  const path = group.parent ? `/products/${group.parent}/variations` : '/products';
  try {
    const { data } = await wooRequest('GET', path, {
      params: { include: rows.map((r) => r[idKey]).join(','), per_page: 100, status: group.parent ? undefined : 'any', _fields: 'id,stock_quantity,manage_stock' },
      retries: 1, timeoutMs: PUSH_LIMITS.readTimeoutMs,
    });
    const m = new Map();
    for (const p of Array.isArray(data) ? data : []) m.set(String(p.id), { qty: p.stock_quantity, managed: p.manage_stock === true });
    return m;
  } catch (err) {
    console.warn('[inventory] push pre-read failed, writing without it:', err.message);
    return null;
  }
}

/**
 * Drain the push queue (spec §7.4) without ever getting stuck:
 *   - time budget: no new chunk is started after budgetMs; unprocessed claims are released at once
 *   - products and variations interleaved by age (oldest request first), so variations are never starved
 *   - small chunks that adapt to Woo's save speed; each chunk is marked as soon as it returns
 *   - a write that times out is not retried (Woo may still finish it); the items back off and the next
 *     run's pre-read sees whether Woo got the value
 *   - pre-read: items Woo already holds are marked done without a save (no plugin hooks, no rewrite)
 *   - Woo lower than our last push and lower than the ledger = a sale in Woo/POS the ledger has not seen
 *     yet → wait push_foreign_change_grace_minutes before writing the ledger value anyway
 * Simple products: POST /products/batch. Variations: POST /products/:parent/variations/batch.
 */
export async function pushStock({ limit = 100, budgetMs = PUSH_LIMITS.budgetMs } = {}) {
  if (!(await pushEnabled())) return { pushed: 0, failed: 0, skipped: 0, disabled: true };
  const t0 = Date.now();
  const due = await rpc('list_stock_push_due', [Math.min(Math.max(limit, 1), 500)]);
  if (!due?.length) return { pushed: 0, failed: 0, skipped: 0 };
  const [g] = await sql(`select coalesce(nullif(inv._setting('push_foreign_change_grace_minutes'), '')::int, 10) as grace`);
  const graceMin = Number(g?.grace ?? 10);

  // Groups: all simple products together, variations per parent. Each keeps request order.
  const groups = new Map();
  for (const r of due) {
    const key = r.woo_variation_id == null ? 'simple' : `v:${r.woo_product_id}`;
    if (!groups.has(key)) groups.set(key, { parent: r.woo_variation_id == null ? null : String(r.woo_product_id), rows: [] });
    groups.get(key).rows.push(r);
  }
  const oldest = (gr) => new Date(gr.rows[0]?.requested_at || 0).getTime();

  const out = { pushed: 0, unchanged: 0, deferred: 0, failed: 0, released: 0, skipped: 0, mirrored: 0, chunks: 0, timeouts: 0 };
  let size = Math.max(1, Math.min(PUSH_LIMITS.chunkStart, PUSH_LIMITS.chunkMax));
  const pending = () => [...groups.values()].filter((gr) => gr.rows.length);

  while (pending().length) {
    if (Date.now() - t0 > budgetMs) { out.budget_exhausted = true; break; }
    const group = pending().sort((a, b) => oldest(a) - oldest(b))[0];
    const slice = group.rows.splice(0, size);
    const idKey = group.parent ? 'woo_variation_id' : 'woo_product_id';
    out.chunks++;

    // 1) What does Woo hold now?
    const current = await readWooStock(group, slice);
    const write = []; const same = []; const defer = [];
    for (const r of slice) {
      const w = current?.get(String(r[idKey]));
      const target = Number(r.qty_to_push);
      if (w && w.managed && Number(w.qty) === target) { same.push({ r, w }); continue; }
      const foreignDrop = w && w.managed && r.last_pushed_qty != null && w.qty != null
        && Number(w.qty) < Number(r.last_pushed_qty) && Number(w.qty) < target;
      const waited = r.deferred_since ? (Date.now() - new Date(r.deferred_since).getTime()) / 60000 : 0;
      if (foreignDrop && graceMin > 0 && waited < graceMin) { defer.push(r); continue; }
      write.push(r);
    }
    for (const { r } of same) await rpc('mark_stock_pushed', [r.item_id, r.qty_to_push, true, null]);
    out.unchanged += same.length;
    if (same.length) {
      out.mirrored += await updateMirror(group.parent ? 'variations' : 'products',
        same.map(({ r, w }) => ({ id: Number(r[idKey]), stock_quantity: Number(w.qty), stock_status: null, manage_stock: true })));
    }
    if (defer.length) {
      await rpc('defer_stock_push', [defer.map((r) => r.item_id), Math.min(graceMin, 5),
        `Woo is lower than our last push (a sale in Woo/POS not yet in the ledger?) — waiting up to ${graceMin} min before writing`]);
      out.deferred += defer.length;
    }
    if (!write.length) continue;

    // 2) Write the rest — one call, no retry on timeout
    const path = group.parent ? `/products/${group.parent}/variations/batch` : '/products/batch';
    const started = Date.now();
    try {
      const { data } = await wooRequest('POST', path, {
        body: { update: write.map((r) => ({ id: r[idKey], manage_stock: true, stock_quantity: Number(r.qty_to_push) })) },
        retries: 0, timeoutMs: PUSH_LIMITS.writeTimeoutMs,
      });
      const o = await applyBatchResult(write, data, idKey);
      out.pushed += o.pushed; out.failed += o.failed; out.mirrored += o.mirrored;
      // Adapt: aim for writes of about targetChunkMs
      const perItem = (Date.now() - started) / write.length;
      size = Math.max(1, Math.min(PUSH_LIMITS.chunkMax, Math.floor(PUSH_LIMITS.targetChunkMs / Math.max(perItem, 1))));
    } catch (err) {
      if (err.timeout) out.timeouts++;
      await markAll(write, false, err.message); out.failed += write.length;
      size = Math.max(1, Math.floor(size / 2));
    }
  }

  // Give back what this run did not get to — the next run picks it up immediately.
  const left = [...groups.values()].flatMap((gr) => gr.rows.map((r) => r.item_id));
  if (left.length) out.released = Number(await rpc('release_stock_push', [left])) || left.length;
  out.ms = Date.now() - t0;
  out.chunk_size = size;
  return out;
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

// Earlier versions only treated publish + private as active, so draft and pending products
// never became usable inv.item rows and could not be put on a purchase order.
const ACTIVE_STATUSES = new Set(['publish', 'private', 'draft', 'pending']);

// Statuses the storefront mirror (public.products) does not carry. publish is
// already applied by inv.upsert_items_from_catalog().
const MIRROR_GAP_STATUSES = ['draft', 'pending', 'private'];

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

/**
 * Stock push only follows publish and private, which is what the worker already
 * did. Draft and pending become active items (so they can be purchased) with
 * track_stock false, and list_stock_push_due skips those.
 */
function pushesStock(status) {
  return status === 'publish' || status === 'private';
}

/** Woo product (+ variations) → inv.item rows. */
export function mapWooProduct(p, variations = [], rules = { mode: 'woo_manage_stock', exclude: [] }, roots = null) {
  const excluded = excludedByRoots(p, rules, roots);
  const track = (managed) => (excluded ? false : rules.mode === 'all' ? true : managed === true);
  if (p.type === 'variable') {
    return variations.map((v) => {
      const variationStatus = v.status || 'publish';
      return {
        sku: v.sku || null,
        woo_product_id: p.id,
        woo_variation_id: v.id,
        name: variationName(p, v),
        // manage_stock 'parent' = stock is managed on the parent → not pushable per variation (woo_manage_stock mode)
        track_stock: pushesStock(p.status) && pushesStock(variationStatus) ? track(v.manage_stock) : false,
        active: ACTIVE_STATUSES.has(p.status) && ACTIVE_STATUSES.has(variationStatus),
      };
    });
  }
  return [{
    sku: p.sku || null,
    woo_product_id: p.id,
    woo_variation_id: null,
    name: p.name,
    track_stock: pushesStock(p.status) ? track(p.manage_stock) : false,
    active: ACTIVE_STATUSES.has(p.status),
  }];
}

async function catalogFromProducts(products) {
  const out = [];
  for (const p of products) {
    let variations = [];
    if (p.type === 'variable') variations = await wooGetAll(`/products/${p.id}/variations`, { status: 'any' });
    out.push({ product: p, variations });
  }
  return out;
}

async function fetchWooCatalog() {
  return catalogFromProducts(await wooGetAll('/products', { status: 'any' }));
}

/** Draft, pending and private products. One request per status so trash is never included. */
async function fetchUnpublishedWooCatalog() {
  const byId = new Map();
  for (const status of MIRROR_GAP_STATUSES) {
    const products = await wooGetAll('/products', { status });
    for (const p of products) {
      // Ignore anything the status query was not asked for, so a published row
      // cannot be written again by this supplement.
      if (p?.id == null || !MIRROR_GAP_STATUSES.includes(p.status) || byId.has(p.id)) continue;
      byId.set(p.id, p);
    }
  }
  return catalogFromProducts([...byId.values()]);
}

async function mapCatalogToItems(catalog) {
  const rules = await getTrackRules();
  const roots = rules.exclude.length ? await categoryRoots() : null;
  return catalog.flatMap(({ product, variations }) => mapWooProduct(product, variations, rules, roots));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * `deactivated` stays the catalog adapter's count. That pass sets gap items
 * inactive because they are missing from the mirror; the supplement writes
 * them active again in `unpublished`. Subtracting the two would hide a product
 * that was really removed in the same run as a brand-new draft.
 */
function mergeCatalogSync(catalog, unpublished) {
  const base = catalog && typeof catalog === 'object' ? catalog : {};
  const extra = unpublished && typeof unpublished === 'object' ? unpublished : {};
  return {
    ...base,
    upserted: Number(base.upserted || 0) + Number(extra.upserted || 0),
    skipped: [...asArray(base.skipped), ...asArray(extra.skipped)],
    unpublished: extra,
  };
}

/**
 * Sync items. Prefers the shop's catalog adapter (inv.upsert_items_from_catalog,
 * reads the Supabase mirror), otherwise Woo REST directly.
 *
 * The mirror only holds published products, and the adapter upserts with
 * deactivate_missing, so a draft that is not in public.products would be
 * turned off. On the auto path those statuses are read from Woo first and
 * upserted afterwards with deactivate_missing false: published rows are not
 * written again, and the drafts stay active.
 */
export async function syncItems({ source = 'auto' } = {}) {
  if (source !== 'woo') {
    // The adapter (0090 / 0091) reads the storefront mirror in the same database — use it when the mirror exists.
    const [{ has }] = await sql(`select to_regprocedure('inv.upsert_items_from_catalog()') is not null
                                        and to_regclass('public.products') is not null as has`);
    if (has) {
      if (source === 'auto' && wooConfigured()) {
        // Map before the adapter. If Woo fails here, deactivate_missing has
        // not run, so previously synced drafts stay active.
        const items = await mapCatalogToItems(await fetchUnpublishedWooCatalog());
        const catalog = await rpc('upsert_items_from_catalog', []);
        const unpublished = items.length
          ? await rpc('upsert_items', { items, deactivate_missing: false })
          : { upserted: 0, deactivated: 0, skipped: [] };
        return mergeCatalogSync(catalog, unpublished);
      }
      return { source: 'catalog_adapter', ...(await rpc('upsert_items_from_catalog', [])) };
    }
    if (source === 'catalog') return { source: 'catalog_adapter', error: 'storefront mirror (public.products) not found in the inventory database' };
  }
  if (!wooConfigured()) throw new WooError(0, 'No catalog adapter and WooCommerce is not configured');
  const items = await mapCatalogToItems(await fetchWooCatalog());
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

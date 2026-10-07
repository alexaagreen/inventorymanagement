// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Ledger → Woo: push av tilgjengelig beholdning (outbox-worker), reconcile, og
// Woo → ledger: synk av varer (produkter/variasjoner → inv.item).
// Ledgeren er master: reconcile retter ALDRI ledgeren fra Woo — bare motsatt.
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

/** Behandle Woo batch-svar: { update: [{ id, stock_quantity } | { id, error: {…} }] } */
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
 * Drener push-køen. Simple produkter: POST /products/batch.
 * Variasjoner: POST /products/:parent/variations/batch (én per parent).
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
      const res = await wooPost('/products/batch', { update: part.map((r) => ({ id: r.woo_product_id, stock_quantity: Number(r.qty_to_push) })) });
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
          update: part.map((r) => ({ id: r.woo_variation_id, stock_quantity: Number(r.qty_to_push) })),
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
 * Start push uten å vente (etter skriv). Cron hvert minutt er garantien;
 * dette gjør bare at Woo oppdateres innen sekunder i normaltilfellet.
 */
export function kickPush() {
  if (process.env.INVENTORY_KICK_PUSH === 'off') return;
  if (!pushEnabledFromConfig() || !wooConfigured()) return;
  pushStock({ limit: 50 }).catch((err) => console.warn('[inventory] kickPush failed:', err.message));
}

// ── Woo-katalog ────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['publish', 'private']);

function variationName(product, v) {
  const attrs = (v.attributes || []).map((a) => a.option).filter(Boolean).join(' / ');
  return attrs ? `${product.name} – ${attrs}` : product.name;
}

/** Woo-produkt (+ variasjoner) → inv.item-rader. */
export function mapWooProduct(p, variations = []) {
  if (p.type === 'variable') {
    return variations.map((v) => ({
      sku: v.sku || null,
      woo_product_id: p.id,
      woo_variation_id: v.id,
      name: variationName(p, v),
      // manage_stock 'parent' = lageret styres på parent-nivå → kan ikke pushes per variasjon
      track_stock: v.manage_stock === true,
      active: ACTIVE_STATUSES.has(p.status) && ACTIVE_STATUSES.has(v.status || 'publish'),
    }));
  }
  return [{
    sku: p.sku || null,
    woo_product_id: p.id,
    woo_variation_id: null,
    name: p.name,
    track_stock: p.manage_stock === true,
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
 * Synk varer. Foretrekker butikkens katalog-adapter (inv.upsert_items_from_catalog,
 * leser Supabase-speilet), ellers Woo REST direkte.
 */
export async function syncItems({ source = 'auto' } = {}) {
  if (source !== 'woo') {
    const [{ has }] = await sql(`select to_regprocedure('inv.upsert_items_from_catalog()') is not null as has`);
    if (has) return { source: 'catalog_adapter', ...(await rpc('upsert_items_from_catalog', [])) };
    if (source === 'catalog') return { source: 'catalog_adapter', error: 'inv.upsert_items_from_catalog() is not installed' };
  }
  if (!wooConfigured()) throw new WooError(0, 'No catalog adapter and WooCommerce is not configured');
  const catalog = await fetchWooCatalog();
  const items = catalog.flatMap(({ product, variations }) => mapWooProduct(product, variations));
  return { source: 'woo', ...(await rpc('upsert_items', { items, deactivate_missing: true })) };
}

/** Upsert ett produkt (webhook product.created/updated). */
export async function upsertWooProduct(product) {
  let variations = [];
  if (product.type === 'variable') variations = await wooGetAll(`/products/${product.id}/variations`, { status: 'any' });
  const items = mapWooProduct(product, variations);
  const res = await rpc('upsert_items', { items, deactivate_missing: false });
  // Variasjoner som er fjernet fra produktet → inaktive
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
 * Sammenlign Woo stock_quantity med ledgerens available for alle sporede varer.
 * fix=true legger avvikene i push-køen og pusher. Woo-verdien skrives aldri inn i ledgeren.
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

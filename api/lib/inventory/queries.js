// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Read queries for the list endpoints. No business logic — only filters,
// sorting and keyset pagination over the views in schema `inv`.
import { sql } from './rpc';
import { encodeCursor, decodeCursor } from './handler';
import { InventoryError } from './errors';

function page(rows, limit, cursorOf) {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  return { data, next_cursor: more ? encodeCursor(cursorOf(data[data.length - 1])) : null };
}

class Where {
  constructor() { this.parts = []; this.params = []; }
  add(clause, ...values) {
    let c = clause;
    for (const v of values) { this.params.push(v); c = c.replace('?', `$${this.params.length}`); }
    this.parts.push(c);
    return this;
  }
  param(v) { this.params.push(v); return `$${this.params.length}`; }
  get sql() { return this.parts.length ? 'where ' + this.parts.join(' and ') : ''; }
}

const MOVEMENT_KIND_TYPES = {
  innkjop: ['purchase_receipt', 'opening_balance'],
  salg: ['sale', 'sale_return'],
  justering: ['adjustment_in', 'adjustment_out', 'write_off'],
  flytting: ['transfer_in', 'transfer_out'],
  reversering: ['reversal'],
};

// ── Items ──────────────────────────────────────────────────────────────────
export async function listItems({ q, active, track_stock, limit, cursor }) {
  const w = new Where();
  if (q) w.add('(i.sku ilike ? or i.name ilike ?)', `%${q}%`, `%${q}%`);
  if (active != null) w.add('i.active = ?', active);
  if (track_stock != null) w.add('i.track_stock = ?', track_stock);
  const c = decodeCursor(cursor);
  if (c) w.add('upper(i.sku) > ?', c.sku);
  // Hits where the SKU starts with the search term first (SKU picker)
  const rank = q ? `case when upper(i.sku) = upper(${w.param(q)}) then 0 when i.sku ilike ${w.param(`${q}%`)} then 1 else 2 end,` : '';
  const rows = await sql(
    `select i.id, i.sku, i.name, i.woo_product_id, i.woo_variation_id, i.track_stock, i.active,
            i.reorder_point, i.reorder_qty, i.attributes, i.synced_at,
            s.on_hand, s.available, s.avg_cost, s.last_purchase_cost
       from inv.item i join inv.v_item_status s on s.item_id = i.id
       ${w.sql} order by ${c ? '' : rank} upper(i.sku) limit ${limit + 1}`, w.params);
  return page(rows, limit, (r) => ({ sku: r.sku.toUpperCase() }));
}

export async function webhookLog({ limit = 50, result }) {
  const w = new Where();
  if (result) w.add('result = ?', result);
  return sql(`select id, topic, resource_id, received_at, result, message
                from inv.woo_webhook_log ${w.sql} order by id desc limit ${Math.min(limit, 500)}`, w.params);
}

// ── Stock ──────────────────────────────────────────────────────────────────
export async function listStock({ skus, location, negative, below_reorder, no_supplier, supplier_id, q, active, limit, cursor, all }) {
  const w = new Where();
  const c = decodeCursor(cursor);
  if (location) {
    if (skus) w.add('upper(sku) = any(?)', skus.map((s) => s.toUpperCase()));
    if (q) w.add('(sku ilike ? or item_name ilike ?)', `%${q}%`, `%${q}%`);
    w.add('location_code = ?', String(location).toUpperCase());
    if (negative) w.add('on_hand < 0');
    if (c) w.add('upper(sku) > ?', c.sku);
    const rows = await sql(
      `select sku, item_name as name, location_code as location, on_hand, value, avg_cost, last_movement_at
         from inv.v_stock_by_location ${w.sql} order by upper(sku) ${all ? '' : `limit ${limit + 1}`}`, w.params);
    return all ? { data: rows, next_cursor: null } : page(rows, limit, (r) => ({ sku: r.sku.toUpperCase() }));
  }
  if (skus) w.add('upper(s.sku) = any(?)', skus.map((x) => x.toUpperCase()));
  if (q) w.add('(s.sku ilike ? or s.name ilike ?)', `%${q}%`, `%${q}%`);
  if (negative) w.add('s.negative');
  if (below_reorder) w.add('s.below_reorder');
  if (no_supplier) w.add('s.track_stock and coalesce(pi.supplier_count, 0) = 0'); // untracked (rental, bundles) need none
  if (supplier_id) w.add('exists (select 1 from inv.item_supplier x where x.item_id = s.item_id and x.supplier_id = ?::uuid)', supplier_id);
  if (active != null) w.add('s.active = ?', active);
  if (c) w.add('upper(s.sku) > ?', c.sku);
  const rows = await sql(
    `select s.sku, s.name, s.woo_product_id, s.woo_variation_id, s.track_stock, s.active,
            s.on_hand, s.on_hand_sellable, s.allocated, s.available, s.on_order, s.next_delivery,
            s.stock_value, s.avg_cost, s.last_purchase_cost, s.last_purchase_at, s.last_movement_at,
            s.negative, s.below_reorder, s.reorder_point, s.open_consumption_qty, s.locations,
            pi.preferred_supplier_id, pi.preferred_supplier, pi.preferred_supplier_sku, coalesce(pi.supplier_count, 0) as supplier_count,
            pi.last_supplier_id, pi.last_supplier, pi.last_unit_cost, pi.last_currency, pi.last_unit_cost_nok, pi.last_po_number
       from inv.v_item_status s left join inv.v_item_purchase_info pi on pi.item_id = s.item_id
       ${w.sql} order by upper(s.sku) ${all ? '' : `limit ${limit + 1}`}`, w.params);
  return all ? { data: rows, next_cursor: null } : page(rows, limit, (r) => ({ sku: r.sku.toUpperCase() }));
}

export async function valuation({ location }) {
  const w = new Where();
  w.add('on_hand <> 0');
  if (location) w.add('location_code = ?', String(location).toUpperCase());
  const rows = await sql(
    `select sku, item_name as name, sum(on_hand) as on_hand, sum(value) as value,
            case when sum(on_hand) > 0 then round(sum(value) / sum(on_hand), 4) end as avg_cost
       from inv.v_stock_by_location ${w.sql}
      group by sku, item_name order by upper(sku)`, w.params);
  const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
  return { total_value: Math.round(total * 100) / 100, location: location || null, rows };
}

// ── Movements ──────────────────────────────────────────────────────────────
export async function listMovements(f) {
  const w = new Where();
  if (f.skus) w.add('upper(sku) = any(?)', f.skus.map((s) => s.toUpperCase()));
  if (f.types) w.add('type::text = any(?)', f.types);
  if (f.kinds) {
    const types = f.kinds.flatMap((k) => MOVEMENT_KIND_TYPES[k] || []);
    w.add('type::text = any(?)', types);
  }
  if (f.location) w.add('location = ?', String(f.location).toUpperCase());
  if (f.supplier_id) w.add('exists (select 1 from inv.item_supplier x where x.item_id = v_movement.item_id and x.supplier_id = ?::uuid)', f.supplier_id);
  if (f.ref_type) w.add('ref_type = ?', f.ref_type);
  if (f.ref_id) w.add('ref_id = ?', String(f.ref_id));
  if (f.from) w.add('occurred_at >= ?', f.from);
  if (f.to) w.add('occurred_at < ?', f.to);
  if (f.by) w.add('created_by ilike ?', `%${f.by}%`);
  if (f.q) w.add('(sku ilike ? or reference ilike ? or note ilike ? or ref_id = ?)', `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, f.q);
  if (!f.include_reversed) w.add('reversed_by is null and reversal_of is null');
  let total;
  if (f.count) {
    const [{ n }] = await sql(`select count(*)::int as n from inv.v_movement ${w.sql}`, w.params);
    total = n;
  }
  const c = decodeCursor(f.cursor);
  if (c) w.add('id < ?', c.id);
  const lim = f.all ? '' : `limit ${f.limit + 1}`;
  const rows = await sql(
    `select id, occurred_at, sku, item_name, location, type, kind, qty, unit_cost, total_cost,
            cost_estimated, cost_source, on_hand_after, ref_type, ref_id, ref_line, reference,
            note, created_by, reversal_of, reversed_by, metadata
       from inv.v_movement ${w.sql} order by id desc ${lim}`, w.params);
  const out = f.all ? { data: rows, next_cursor: null } : page(rows, f.limit, (r) => ({ id: r.id }));
  if (total != null) out.total = total;
  return out;
}

export async function getMovement(id) {
  const rows = await sql(
    `select inv._movement_json($1::bigint) as m,
            (select coalesce(jsonb_agg(to_jsonb(cc) order by cc.id), '[]') from inv.cogs_correction cc where cc.movement_id = $1::bigint) as corrections`,
    [id]);
  if (!rows[0]?.m) return null;
  return { ...rows[0].m, cogs_corrections: rows[0].corrections };
}

export async function cogsReport({ from, to, group_by, location }) {
  const group = { sku: 'sku', day: `(occurred_at at time zone 'Europe/Oslo')::date`, ref: `coalesce(ref_type,'') || ':' || coalesce(ref_id,'')` }[group_by || 'sku'];
  if (!group) throw new InventoryError('VALIDATION', 'group_by must be sku, day or ref');
  const w = new Where();
  w.add(`type in ('sale','sale_return')`);
  w.add('reversed_by is null');
  if (from) w.add('occurred_at >= ?', from);
  if (to) w.add('occurred_at < ?', to);
  if (location) w.add('location = ?', String(location).toUpperCase());
  const rows = await sql(
    `select ${group} as key,
            sum(case when type = 'sale' then -qty else 0 end) as qty_sold,
            sum(case when type = 'sale_return' then qty else 0 end) as qty_returned,
            round(sum(case when type = 'sale' then total_cost else -total_cost end), 2) as cogs,
            bool_or(cost_estimated) as has_estimates
       from inv.v_movement ${w.sql}
      group by 1 order by 1`, w.params);
  const cw = new Where();
  if (from) cw.add('created_at >= ?', from);
  if (to) cw.add('created_at < ?', to);
  const [corr] = await sql(`select coalesce(round(sum(delta_cost), 2), 0) as delta from inv.cogs_correction ${cw.sql}`, cw.params);
  const total = rows.reduce((s, r) => s + Number(r.cogs || 0), 0);
  return {
    from: from || null, to: to || null, group_by: group_by || 'sku',
    total_cogs: Math.round(total * 100) / 100,
    // Corrections booked in the period (estimated → actual cost). Already included
    // in cogs for sales in the period; shown separately for period close.
    corrections_booked_in_period: Number(corr.delta),
    rows,
  };
}

// ── Documents ──────────────────────────────────────────────────────────────
function docPage(rows, limit) {
  return page(rows, limit, (r) => ({ t: r.created_at, id: r.id }));
}
function docCursor(w, cursor) {
  const c = decodeCursor(cursor);
  if (c) w.add('(created_at, id) < (?::timestamptz, ?::uuid)', c.t, c.id);
}

export async function listPurchaseOrders({ statuses, supplier, supplier_id, q, from, to, limit, cursor }) {
  const w = new Where();
  if (statuses) w.add('po.status::text = any(?)', statuses);
  if (supplier) w.add('po.supplier_name ilike ?', `%${supplier}%`);
  if (supplier_id) w.add('po.supplier_uuid = ?::uuid', supplier_id);
  if (q) w.add('(po.number ilike ? or po.supplier_name ilike ? or po.supplier_ref ilike ? or exists (select 1 from inv.purchase_order_line l where l.po_id = po.id and l.sku ilike ?))',
    `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  if (from) w.add('po.created_at >= ?', from);
  if (to) w.add('po.created_at < ?', to);
  const c = decodeCursor(cursor);
  if (c) w.add('(po.created_at, po.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(
    `select po.id, po.number, po.status, po.supplier_name, po.supplier_uuid, po.supplier_ref, po.currency, po.fx_rate,
            l.code as location, po.order_date, po.expected_at, po.created_by, po.created_at, po.sent_at, po.received_at,
            (select count(*)::int from inv.purchase_order_line x where x.po_id = po.id) as line_count,
            (select coalesce(sum(qty_ordered), 0) from inv.purchase_order_line x where x.po_id = po.id) as qty_ordered,
            (select coalesce(sum(qty_received), 0) from inv.purchase_order_line x where x.po_id = po.id) as qty_received,
            (select coalesce(round(sum(qty_ordered * unit_cost), 2), 0) from inv.purchase_order_line x where x.po_id = po.id) as amount
       from inv.purchase_order po left join inv.location l on l.id = po.location_id
       ${w.sql} order by po.created_at desc, po.id desc limit ${limit + 1}`, w.params);
  return docPage(rows, limit);
}

export async function onOrder({ skus }) {
  const w = new Where();
  w.add(`po.status in ('sent','partially_received')`);
  w.add('pl.qty_ordered > pl.qty_received');
  if (skus) w.add('upper(pl.sku) = any(?)', skus.map((s) => s.toUpperCase()));
  return sql(
    `select pl.sku, po.id as po_id, po.number as po_number, po.supplier_name, po.status,
            pl.qty_ordered - pl.qty_received as qty_open, po.expected_at
       from inv.purchase_order_line pl join inv.purchase_order po on po.id = pl.po_id
       ${w.sql} order by pl.sku, po.expected_at nulls last, po.number`, w.params);
}

export async function listReceipts({ po_id, from, to, limit, cursor }) {
  const w = new Where();
  if (po_id) w.add('gr.po_id = ?::uuid', po_id);
  if (from) w.add('gr.received_at >= ?', from);
  if (to) w.add('gr.received_at < ?', to);
  const c = decodeCursor(cursor);
  if (c) w.add('(gr.created_at, gr.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(
    `select gr.id, gr.number, gr.status, gr.received_at, gr.received_by, gr.fx_rate, gr.note, gr.created_at,
            po.id as po_id, po.number as po_number, po.supplier_name, l.code as location,
            (select coalesce(sum(qty), 0) from inv.goods_receipt_line x where x.receipt_id = gr.id) as qty,
            (select coalesce(round(sum(qty * unit_cost_base), 2), 0) from inv.goods_receipt_line x where x.receipt_id = gr.id) as value
       from inv.goods_receipt gr
       join inv.purchase_order po on po.id = gr.po_id
       join inv.location l on l.id = gr.location_id
       ${w.sql} order by gr.created_at desc, gr.id desc limit ${limit + 1}`, w.params);
  return page(rows, limit, (r) => ({ t: r.created_at, id: r.id }));
}

export async function listAdjustments({ from, to, location, reason, by, q, limit, cursor }) {
  const w = new Where();
  if (from) w.add('a.occurred_at >= ?', from);
  if (to) w.add('a.occurred_at < ?', to);
  if (location) w.add('l.code = ?', String(location).toUpperCase());
  if (reason) w.add('a.reason ilike ?', `%${reason}%`);
  if (by) w.add('a.created_by ilike ?', `%${by}%`);
  if (q) w.add('(a.number ilike ? or a.note ilike ? or exists (select 1 from inv.adjustment_line al join inv.item i on i.id = al.item_id where al.adjustment_id = a.id and i.sku ilike ?))',
    `%${q}%`, `%${q}%`, `%${q}%`);
  const c = decodeCursor(cursor);
  if (c) w.add('(a.created_at, a.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(
    `select a.id, a.number, a.status, a.reason, a.note, a.write_off, a.created_by, a.occurred_at, a.created_at,
            l.code as location,
            (select count(*)::int from inv.adjustment_line x where x.adjustment_id = a.id) as line_count,
            (select coalesce(sum(qty_delta), 0) from inv.adjustment_line x where x.adjustment_id = a.id) as qty_delta,
            (select coalesce(round(sum(m.qty * m.unit_cost), 2), 0)
               from inv.adjustment_line x join inv.movement m on m.id in (x.movement_id, x.revalue_out_movement_id)
              where x.adjustment_id = a.id) as value_delta
       from inv.adjustment a join inv.location l on l.id = a.location_id
       ${w.sql} order by a.created_at desc, a.id desc limit ${limit + 1}`, w.params);
  return docPage(rows, limit);
}

export async function listTransfers({ from, to, location, limit, cursor }) {
  const w = new Where();
  if (from) w.add('t.occurred_at >= ?', from);
  if (to) w.add('t.occurred_at < ?', to);
  if (location) w.add('(lf.code = ? or lt.code = ?)', String(location).toUpperCase(), String(location).toUpperCase());
  const c = decodeCursor(cursor);
  if (c) w.add('(t.created_at, t.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(
    `select t.id, t.number, t.status, t.note, t.created_by, t.occurred_at, t.created_at,
            lf.code as from_location, lt.code as to_location,
            (select coalesce(sum(qty), 0) from inv.transfer_line x where x.transfer_id = t.id) as qty
       from inv.transfer t
       join inv.location lf on lf.id = t.from_location_id
       join inv.location lt on lt.id = t.to_location_id
       ${w.sql} order by t.created_at desc, t.id desc limit ${limit + 1}`, w.params);
  return docPage(rows, limit);
}

export async function getDoc(kind, id) {
  const fn = { adjustment: '_adjustment_json', transfer: '_transfer_json', receipt: '_receipt_json', po: '_po_json' }[kind];
  const rows = await sql(`select inv.${fn}($1::uuid) as d`, [id]);
  return rows[0]?.d || null;
}

// ── Suppliers ──────────────────────────────────────────────────────────────
export async function listSuppliers({ q, active, limit, cursor }) {
  const w = new Where();
  if (q) w.add('(name ilike ? or code ilike ? or email ilike ?)', `%${q}%`, `%${q}%`, `%${q}%`);
  if (active != null) w.add('active = ?', active);
  const c = decodeCursor(cursor);
  if (c) w.add('(lower(name), id) > (?, ?::uuid)', c.n, c.id);
  const rows = await sql(
    `select id, name, code, currency, contact_name, email, phone, website, default_lead_time_days, note, active,
            order_unit, rules,
            item_count, preferred_count, open_po_count, last_receipt_at, created_at, updated_at
       from inv.v_supplier ${w.sql} order by lower(name), id limit ${limit + 1}`, w.params);
  return page(rows, limit, (r) => ({ n: r.name.toLowerCase(), id: r.id }));
}

/** Supplier by uuid, code or name (case-insensitive) → uuid; SUPPLIER_NOT_FOUND otherwise. */
export async function resolveSupplierId(ref) {
  const r = String(ref ?? '').trim();
  if (!r) throw new InventoryError('VALIDATION', 'supplier is required', { field: 'supplier' });
  const [row] = await sql('select inv._find_supplier($1) as id', [r]);
  if (!row?.id) throw new InventoryError('SUPPLIER_NOT_FOUND', 'supplier not found', { supplier: r });
  return row.id;
}

export async function getSupplier(ref) {
  const id = await resolveSupplierId(ref);
  const [s] = await sql('select * from inv.v_supplier where id = $1::uuid', [id]);
  if (!s) throw new InventoryError('SUPPLIER_NOT_FOUND', 'supplier not found', { supplier: id });
  const items = await sql(
    `select x.sku, i.name, x.preferred, x.supplier_sku, x.pack_qty, x.pack_name, x.pack_gtin,
            x.list_price, x.list_currency, x.lead_time_days, x.min_order_qty,
            x.last_purchase_at, x.last_unit_cost, x.last_currency, x.last_unit_cost_nok, x.qty_purchased,
            st.on_hand, st.available, i.active
       from inv.v_item_supplier x join inv.item i on i.id = x.item_id join inv.v_item_status st on st.item_id = x.item_id
      where x.supplier_id = $1::uuid order by upper(x.sku)`, [id]);
  const purchase_orders = await sql(
    `select id, number, status, currency, expected_at, created_at, received_at
       from inv.purchase_order where supplier_uuid = $1::uuid order by created_at desc limit 20`, [id]);
  return { ...s, items, purchase_orders };
}

// ── Order reconcile (v0.9.0) ───────────────────────────────────────────────
const RUN_COLS = `id, trigger, run_by, status, window_from, window_to, started_at, finished_at,
  orders_checked, orders_changed, movements, missing_checked, issues_new, issues_seen, issues_resolved, issues_open, error,
  (extract(epoch from (coalesce(finished_at, now()) - started_at)) * 1000)::bigint as duration_ms`;
const ISSUE_STATUS = {
  open: 'x.resolved_at is null',
  resolved: "x.resolved_at is not null and x.resolution in ('auto', 'manual')",
  ignored: "x.resolution = 'ignored'",
  all: null,
};

export async function listOrderReconcileRuns({ status, limit, cursor }) {
  const w = new Where();
  if (status) w.add('status = any(?::text[])', status);
  const c = decodeCursor(cursor);
  if (c) w.add('(started_at, id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(`select ${RUN_COLS} from inv.order_reconcile_run ${w.sql}
                           order by started_at desc, id desc limit ${limit + 1}`, w.params);
  return page(rows, limit, (r) => ({ t: r.started_at, id: r.id }));
}

export async function getOrderReconcileRun(id) {
  const [run] = await sql(`select ${RUN_COLS}, issue_ids, changes, log from inv.order_reconcile_run where id = $1::uuid`, [id]);
  if (!run) throw new InventoryError('NOT_FOUND', 'reconcile run not found', { id });
  const issues = await sql(
    `select x.* from inv.order_reconcile_issue x where x.id = any($1::uuid[])
      order by x.woo_order_id desc, x.kind, x.ref`, [run.issue_ids || []]);
  const { issue_ids, ...rest } = run;
  return { ...rest, issues };
}

export async function listOrderReconcileIssues({ status = 'open', kind, order, limit, cursor }) {
  if (!(status in ISSUE_STATUS)) throw new InventoryError('VALIDATION', 'status must be open, resolved, ignored or all', { field: 'status' });
  const w = new Where();
  if (ISSUE_STATUS[status]) w.add(ISSUE_STATUS[status]);
  if (kind) w.add('x.kind = any(?::text[])', kind);
  if (order) w.add('(x.woo_order_id::text = ? or x.order_number = ?)', String(order).replace(/^#/, ''), String(order).replace(/^#/, ''));
  const c = decodeCursor(cursor);
  if (c) w.add('(x.last_seen_at, x.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(`select x.* from inv.order_reconcile_issue x ${w.sql}
                           order by x.last_seen_at desc, x.id desc limit ${limit + 1}`, w.params);
  const out = page(rows, limit, (r) => ({ t: r.last_seen_at, id: r.id }));
  const [counts] = await sql(`select count(*) filter (where resolved_at is null)::int as open,
                                     count(*) filter (where resolution = 'ignored')::int as ignored
                                from inv.order_reconcile_issue`);
  return { ...out, counts };
}

export async function orderReconcileSummary() {
  const [last] = await sql(`select ${RUN_COLS} from inv.order_reconcile_run order by started_at desc, id desc limit 1`);
  const [lastOk] = await sql(`select finished_at from inv.order_reconcile_run where status in ('ok', 'issues')
                               order by started_at desc limit 1`);
  const [{ open }] = await sql('select count(*)::int as open from inv.order_reconcile_issue where resolved_at is null');
  return { last_run: last || null, last_completed_at: lastOk?.finished_at || null, open_issues: open };
}

// ── Agent-friendly reads (v0.10.0) ─────────────────────────────────────────
const DAY = 86400000;
/** Period for movement summaries: [from, to), default the last 90 days. */
export function period(from, to, days = 90) {
  const t = to ? new Date(to) : new Date();
  const f = from ? new Date(from) : new Date(t.getTime() - days * DAY);
  if (Number.isNaN(t.getTime()) || Number.isNaN(f.getTime())) throw new InventoryError('VALIDATION', 'from/to must be dates', { field: 'from' });
  if (f >= t) throw new InventoryError('VALIDATION', 'from must be before to', { field: 'from' });
  return { from: f.toISOString(), to: t.toISOString() };
}

// Per item, inside [from, to): what moved. Quantities are in units (sale = negative qty in the ledger).
//   sold_net = sold − returned; received = purchase receipts + opening balance; adjusted = adjustments + write-offs
//   (signed); transferred_net is 0 for the item overall (it moves between locations); reversals = net qty of reversals.
const SUMMARY_SQL = `
  select m.item_id,
         count(*)::int as movements,
         coalesce(sum(m.qty) filter (where m.qty > 0), 0) as qty_in,
         coalesce(-sum(m.qty) filter (where m.qty < 0), 0) as qty_out,
         coalesce(-sum(m.qty) filter (where m.type in ('sale', 'sale_return')), 0) as sold_net,
         coalesce(sum(m.qty) filter (where m.type in ('purchase_receipt', 'opening_balance')), 0) as received,
         coalesce(sum(m.qty) filter (where m.type in ('adjustment_in', 'adjustment_out', 'write_off')), 0) as adjusted,
         coalesce(sum(m.qty) filter (where m.type in ('transfer_in', 'transfer_out')), 0) as transferred_net,
         coalesce(sum(m.qty) filter (where m.type = 'reversal'), 0) as reversals,
         coalesce(sum(m.qty), 0) as net_change,
         round(coalesce(sum(m.total_cost) filter (where m.type = 'sale'), 0)
               - coalesce(sum(m.total_cost) filter (where m.type = 'sale_return'), 0), 2) as cogs,
         max(m.occurred_at) as last_movement_at
    from inv.movement m
   where m.occurred_at >= $1::timestamptz and m.occurred_at < $2::timestamptz`;
const EMPTY_SUMMARY = { movements: 0, qty_in: 0, qty_out: 0, sold_net: 0, received: 0, adjusted: 0, transferred_net: 0, reversals: 0, net_change: 0, cogs: 0, last_movement_at: null };

/** All items bought from a supplier, with stock, the supplier link and a movement summary for the period. */
export async function listSupplierItems(ref, { from, to, q, include_inactive = false } = {}) {
  const id = await resolveSupplierId(ref);
  const p = period(from, to);
  const [s] = await sql(`select id, name, code, currency, order_unit, rules, default_lead_time_days, active from inv.supplier where id = $1::uuid`, [id]);
  const params = [p.from, p.to, id];
  let extra = '';
  if (!include_inactive) extra += ' and i.active';
  if (q) { params.push(`%${q}%`); extra += ` and (i.sku ilike $${params.length} or i.name ilike $${params.length} or x.supplier_sku ilike $${params.length})`; }
  const rows = await sql(
    `with mv as (${SUMMARY_SQL} and m.item_id in (select item_id from inv.item_supplier where supplier_id = $3::uuid) group by m.item_id)
     select i.sku, i.name, i.active, i.track_stock, i.woo_product_id, i.woo_variation_id,
            x.preferred, x.supplier_sku, x.pack_qty, x.pack_name, x.pack_gtin,
            x.list_price, x.list_currency, x.lead_time_days, x.min_order_qty,
            x.last_purchase_at, x.last_unit_cost, x.last_currency, x.last_unit_cost_nok, x.last_po_number, x.qty_purchased,
            st.on_hand, st.available, st.allocated, st.on_order, st.next_delivery, st.avg_cost, st.stock_value,
            st.reorder_point, st.below_reorder, st.negative, st.last_movement_at as last_movement_at_any,
            to_jsonb(mv) - 'item_id' as period_summary
       from inv.v_item_supplier x
       join inv.item i on i.id = x.item_id
       join inv.v_item_status st on st.item_id = x.item_id
       left join mv on mv.item_id = x.item_id
      where x.supplier_id = $3::uuid ${extra}
      order by upper(i.sku)`, params);
  for (const r of rows) r.period_summary = r.period_summary || { ...EMPTY_SUMMARY };
  return { supplier: s, period: p, count: rows.length, data: rows };
}

/** One item: current stock, a movement summary for the period and the movements themselves (newest first). */
export async function itemMovements(sku, f = {}) {
  const [it] = await sql(
    `select item_id, sku, name, active, track_stock, on_hand, available, allocated, on_order, next_delivery,
            avg_cost, stock_value, last_purchase_cost, last_purchase_at, last_movement_at, locations
       from inv.v_item_status where upper(sku) = upper($1)`, [sku]);
  if (!it) throw new InventoryError('ITEM_NOT_FOUND', `item ${sku} not found`, { sku });
  const p = period(f.from, f.to);
  const [sum] = await sql(`select to_jsonb(s) as j from (${SUMMARY_SQL} and m.item_id = $3::uuid group by m.item_id) s`, [p.from, p.to, it.item_id]);
  const suppliers = await sql(
    `select supplier_id, supplier_name, preferred, supplier_sku, pack_qty, pack_name, last_purchase_at, last_unit_cost, last_currency
       from inv.v_item_supplier where item_id = $1::uuid order by preferred desc, last_purchase_at desc nulls last`, [it.item_id]);
  const list = await listMovements({ ...f, skus: [it.sku], from: f.from || p.from, to: f.to || p.to });
  const { item_id, ...item } = it;
  const { item_id: _x, ...summary } = sum?.j || { item_id: null, ...EMPTY_SUMMARY };
  return { item: { ...item, suppliers }, period: p, summary, ...list };
}

// ── Month close (v0.11.0) ──────────────────────────────────────────────────
// A month close is a frozen picture of qty and value per item × location at the end of a
// month (inv.month_close / inv.month_close_line). Reports read it per SKU (locations summed,
// with a per-location breakdown) or per SKU × location, and compare with the month before.

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function requirePeriod(v) {
  const s = String(Array.isArray(v) ? v[0] : v || '').slice(0, 7);
  if (!PERIOD_RE.test(s)) throw new InventoryError('VALIDATION', 'period must be YYYY-MM', { field: 'period', value: v });
  return s;
}
function shiftPeriod(period, months) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const BACKDATED_SQL = `(select count(*)::int from inv.movement m where m.id > c.movement_watermark and m.occurred_at < c.cutoff_at)`;
const CLOSE_COLS = `c.id, to_char(c.period, 'YYYY-MM') as period, c.cutoff_at, c.timezone, c.total_qty, c.total_value,
  c.sku_count, c.line_count, c.negative_lines, c.source, c.closed_by, c.closed_at, c.recalculated_at,
  c.recalculated_by, c.recalc_count, c.note, ${BACKDATED_SQL} as backdated_movements`;

/** All month closes, newest first, with change vs the month before and the months that are not closed yet. */
export async function listMonthCloses() {
  const rows = await sql(
    `select ${CLOSE_COLS},
            case when lag(c.period) over w = (c.period - interval '1 month')::date then lag(c.total_value) over w end as prev_total_value
       from inv.month_close c
     window w as (order by c.period)
      order by c.period desc`);
  for (const r of rows) {
    r.delta_value = r.prev_total_value == null ? null
      : Math.round((Number(r.total_value) - Number(r.prev_total_value)) * 100) / 100;
  }
  const [o] = await sql(
    `with b as (
       select date_trunc('month', (select min(occurred_at) from inv.movement) at time zone inv._tz())::date as first,
              (date_trunc('month', now() at time zone inv._tz()) - interval '1 month')::date as last
     )
     select to_char(b.first, 'YYYY-MM') as first_period, to_char(b.last, 'YYYY-MM') as last_completed,
            coalesce((select jsonb_agg(to_char(g, 'YYYY-MM') order by g)
                        from generate_series(b.first, b.last, interval '1 month') g
                       where not exists (select 1 from inv.month_close c where c.period = g::date)), '[]') as missing
       from b`);
  return { data: rows, first_period: o.first_period, last_completed: o.last_completed, missing: o.first_period ? o.missing : [] };
}

const EMPTY_SRC = `select null::uuid as item_id, null::text as sku, null::text as item_name, null::text as location_code,
  0::numeric as qty, 0::numeric as value where false`;

/** Shared report: cur/prev are subqueries giving (item_id, sku, item_name, location_code, qty, value). */
async function stockReport({ cur, prev, params = [], by = 'sku', location, q }) {
  if (!['sku', 'location'].includes(by)) throw new InventoryError('VALIDATION', 'by must be sku or location', { field: 'by' });
  const ps = [...params];
  const p = (v) => { ps.push(v); return `$${ps.length}`; };
  const perLoc = by === 'location';
  const locF = location ? `where s.location_code = ${p(String(location).toUpperCase())}` : '';
  const agg = (src) => `select s.item_id, ${perLoc ? 's.location_code,' : ''} max(s.sku) as sku, max(s.item_name) as item_name,
         sum(s.qty) as qty, sum(s.value) as value
         ${perLoc ? '' : `, jsonb_object_agg(s.location_code, jsonb_build_object('qty', s.qty, 'value', s.value)) as locations`}
    from (${src}) s ${locF} group by s.item_id ${perLoc ? ', s.location_code' : ''}`;
  const hasPrev = !!prev;
  const qF = q ? `where (coalesce(c.sku, pv.sku) ilike ${p(`%${q}%`)} or coalesce(c.item_name, pv.item_name) ilike ${p(`%${q}%`)})` : '';
  const rows = await sql(
    `with cur as (${agg(cur)}), prev as (${agg(prev || EMPTY_SRC)})
     select coalesce(c.sku, pv.sku) as sku, coalesce(c.item_name, pv.item_name) as name,
            ${perLoc ? 'coalesce(c.location_code, pv.location_code) as location,' : ''}
            coalesce(c.qty, 0) as qty, coalesce(c.value, 0) as value,
            case when c.qty > 0 then round(c.value / c.qty, 4) end as unit_cost
            ${perLoc ? '' : `, coalesce(c.locations, '{}'::jsonb) as locations`}
            ${hasPrev ? `, coalesce(pv.qty, 0) as prev_qty, coalesce(pv.value, 0) as prev_value,
                          coalesce(c.qty, 0) - coalesce(pv.qty, 0) as delta_qty,
                          coalesce(c.value, 0) - coalesce(pv.value, 0) as delta_value` : ''}
       from cur c full join prev pv on pv.item_id = c.item_id ${perLoc ? 'and pv.location_code = c.location_code' : ''}
       ${qF}
      order by upper(coalesce(c.sku, pv.sku)) ${perLoc ? ', 3' : ''}`, ps);
  const sum = (k) => Math.round(rows.reduce((s, r) => s + Number(r[k] || 0), 0) * 1000) / 1000;
  const totals = { rows: rows.length, qty: sum('qty'), value: Math.round(sum('value') * 100) / 100 };
  if (hasPrev) {
    totals.prev_qty = sum('prev_qty');
    totals.prev_value = Math.round(sum('prev_value') * 100) / 100;
    totals.delta_value = Math.round((totals.value - totals.prev_value) * 100) / 100;
  }
  return { totals, rows };
}

const lineSrc = (param) => `select l.item_id, l.sku, l.item_name, l.location_code, l.qty, l.value
  from inv.month_close_line l where l.close_id = ${param}::uuid`;

/** One month close: header, neighbours (for paging back and forth in time) and lines. */
export async function getMonthClose(periodText, { by = 'sku', location, q, compare = true } = {}) {
  const period = requirePeriod(periodText);
  const [c] = await sql(`select ${CLOSE_COLS}, c.history from inv.month_close c where c.period = to_date($1 || '-01', 'YYYY-MM-DD')`, [period]);
  if (!c) throw new InventoryError('NOT_FOUND', `month ${period} is not closed`, { period });
  const nb = await sql(
    `select (select to_char(period, 'YYYY-MM') from inv.month_close where period < $1::date order by period desc limit 1) as older,
            (select to_char(period, 'YYYY-MM') from inv.month_close where period > $1::date order by period limit 1) as newer,
            (select id from inv.month_close where period = ($1::date - interval '1 month')::date) as prev_id`,
    [`${period}-01`]);
  const prevId = compare ? nb[0].prev_id : null;
  const out = await stockReport({
    cur: lineSrc('$1'), prev: prevId ? lineSrc('$2') : null,
    params: prevId ? [c.id, prevId] : [c.id], by, location, q,
  });
  return {
    close: c,
    previous_period: prevId ? shiftPeriod(period, -1) : null,
    older: nb[0].older, newer: nb[0].newer,
    by, location: location || null, q: q || null, ...out,
  };
}

/** Stock as of any point in time, rebuilt from the ledger (not frozen). `at` is exclusive. */
export async function stockAsOf({ at, by = 'sku', location, q }) {
  if (!at) throw new InventoryError('VALIDATION', 'at is required', { field: 'at' });
  // A bare date means the end of that day in the shop's time zone.
  const [{ cutoff }] = await sql(
    `select case when $1 ~ '^\\d{4}-\\d{2}-\\d{2}$'
                 then (($1::date + 1)::timestamp at time zone inv._tz())
                 else $1::timestamptz end as cutoff`, [String(at)]);
  const out = await stockReport({
    cur: `select s.item_id, i.sku, i.name as item_name, loc.code as location_code, s.qty, s.value
            from inv._stock_as_of($1::timestamptz) s
            join inv.item i on i.id = s.item_id join inv.location loc on loc.id = s.location_id`,
    params: [cutoff], by, location, q,
  });
  return { at: String(at), cutoff_at: cutoff, by, location: location || null, q: q || null, ...out };
}

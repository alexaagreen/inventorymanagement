// inventory-ledger v0.9.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
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
            item_count, preferred_count, open_po_count, last_receipt_at, created_at, updated_at
       from inv.v_supplier ${w.sql} order by lower(name), id limit ${limit + 1}`, w.params);
  return page(rows, limit, (r) => ({ n: r.name.toLowerCase(), id: r.id }));
}

export async function getSupplier(id) {
  const [s] = await sql('select * from inv.v_supplier where id = $1::uuid', [id]);
  if (!s) throw new InventoryError('SUPPLIER_NOT_FOUND', 'supplier not found', { supplier: id });
  const items = await sql(
    `select x.sku, i.name, x.preferred, x.supplier_sku, x.list_price, x.list_currency, x.lead_time_days, x.min_order_qty,
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

// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
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
  // Rows whose SKU starts with the query rank first (the SKU picker)
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
export async function listStock({ skus, location, negative, below_reorder, q, active, limit, cursor, all }) {
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
  if (skus) w.add('upper(sku) = any(?)', skus.map((s) => s.toUpperCase()));
  if (q) w.add('(sku ilike ? or name ilike ?)', `%${q}%`, `%${q}%`);
  if (negative) w.add('negative');
  if (below_reorder) w.add('below_reorder');
  if (active != null) w.add('active = ?', active);
  if (c) w.add('upper(sku) > ?', c.sku);
  const rows = await sql(
    `select sku, name, woo_product_id, woo_variation_id, track_stock, active,
            on_hand, on_hand_sellable, allocated, available, on_order, next_delivery,
            stock_value, avg_cost, last_purchase_cost, last_purchase_at, last_movement_at,
            negative, below_reorder, reorder_point, open_consumption_qty, locations
       from inv.v_item_status ${w.sql} order by upper(sku) ${all ? '' : `limit ${limit + 1}`}`, w.params);
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
    // in COGS for sales in the period; shown separately for period close.
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

export async function listPurchaseOrders({ statuses, supplier, q, from, to, limit, cursor }) {
  const w = new Where();
  if (statuses) w.add('po.status::text = any(?)', statuses);
  if (supplier) w.add('po.supplier_name ilike ?', `%${supplier}%`);
  if (q) w.add('(po.number ilike ? or po.supplier_name ilike ? or po.supplier_ref ilike ? or exists (select 1 from inv.purchase_order_line l where l.po_id = po.id and l.sku ilike ?))',
    `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  if (from) w.add('po.created_at >= ?', from);
  if (to) w.add('po.created_at < ?', to);
  const c = decodeCursor(cursor);
  if (c) w.add('(po.created_at, po.id) < (?::timestamptz, ?::uuid)', c.t, c.id);
  const rows = await sql(
    `select po.id, po.number, po.status, po.supplier_name, po.supplier_ref, po.currency, po.fx_rate,
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

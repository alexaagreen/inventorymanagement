-- inventory-ledger v0.12.0
-- =============================================================================
-- 0100_inv_margin_landed_cost.sql — margin per sale (cost tracing) + landed cost allocation
-- =============================================================================
-- Two things, both built on what the ledger already records (spec §6.9 and §6.10):
--
-- 1. COST TRACING (read only)
--    Every sale already knows which FIFO layers it consumed (inv.layer_consumption), and
--    every layer knows the inbound movement that created it — a goods receipt on a PO, an
--    opening balance, an adjustment … Transfers and reversals re-create layers and point at
--    the layer they came from (cost_layer.source_layer_id). The views here walk that chain:
--      inv.v_consumption_source  one row per (outbound movement × consumed layer) with the
--                                origin of the cost: receipt, PO, supplier, currency, fx
--      inv.v_sale_movement       sale / sale_return movements mapped to (source, order, line)
--      inv.v_sale_line_cost      one row per sold order line: qty sold/returned, net COGS
--      inv.v_sale_cost_source    v_consumption_source for sales, with the order line on it
--    The ledger owns cost and tracing. Revenue (the sales price) lives in the shop; margin is
--    the shop's revenue line joined to v_sale_line_cost on (source, order_id, line_id).
--
-- 2. LANDED COST ALLOCATION (write)
--    Freight, duty and fees invoiced after the goods were received are spread over one or
--    more goods receipts. For every receipt line the cost per unit goes up by a delta, and
--    that delta follows the units wherever they are now:
--      • still in stock (also after a transfer)  → the FIFO layer is revalued → stock value
--      • already sold                            → the sale's COGS is corrected and logged
--                                                  in inv.cogs_correction (reason landed_cost)
--      • adjusted out / written off              → that movement's cost is corrected
--    A landed cost can be reversed; the same delta is taken out again along the same chain.
--    Units returned by a customer keep the cost they were returned at (spec §3.8).
--
-- Also: record_sale_return stores which sale it returns (metadata.original_ref_*), so manual
-- returns land on the right order line, and reverse_goods_receipt refuses a receipt that
-- still carries a posted landed cost (reverse the landed cost first).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
create sequence if not exists inv.lc_number_seq;

create table if not exists inv.landed_cost (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique,
  status        text not null default 'posted' check (status in ('posted','reversed')),
  description   text,
  vendor        text,
  invoice_ref   text,
  currency      text not null,
  fx_rate       numeric(14,6) not null check (fx_rate > 0),
  amount        numeric(14,2) not null check (amount > 0),
  amount_base   numeric(14,2) not null check (amount_base > 0),
  method        text not null check (method in ('value','qty','manual')),
  -- What the allocation actually moved, in base currency. applied_base differs from
  -- amount_base only by rounding (the delta per unit has 4 decimals).
  applied_base  numeric(14,2) not null default 0,
  to_stock      numeric(14,2) not null default 0,
  to_cogs       numeric(14,2) not null default 0,
  to_other      numeric(14,2) not null default 0,
  occurred_at   timestamptz not null default now(),
  note          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  reversed_at   timestamptz,
  reversed_by   text,
  reverse_note  text
);
create index if not exists idx_landed_cost_created on inv.landed_cost (created_at desc, id desc);

create table if not exists inv.landed_cost_line (
  id                uuid primary key default gen_random_uuid(),
  landed_cost_id    uuid not null references inv.landed_cost(id) on delete cascade,
  position          int not null default 0,
  receipt_id        uuid not null references inv.goods_receipt(id),
  receipt_line_id   uuid not null references inv.goods_receipt_line(id),
  item_id           uuid not null references inv.item(id),
  movement_id       bigint not null references inv.movement(id),
  qty               numeric(14,3) not null,
  basis             numeric(18,4) not null,
  amount_base       numeric(14,2) not null,
  unit_delta        numeric(14,4) not null,
  unit_cost_before  numeric(14,4) not null,
  unit_cost_after   numeric(14,4) not null,
  -- Where the units of the receipt line were when the landed cost was posted
  qty_in_stock      numeric(14,3) not null default 0,
  qty_sold          numeric(14,3) not null default 0,
  qty_other         numeric(14,3) not null default 0,
  to_stock          numeric(14,2) not null default 0,
  to_cogs           numeric(14,2) not null default 0,
  to_other          numeric(14,2) not null default 0
);
create index if not exists idx_landed_cost_line_doc     on inv.landed_cost_line (landed_cost_id);
create index if not exists idx_landed_cost_line_receipt on inv.landed_cost_line (receipt_id);
create index if not exists idx_landed_cost_line_grl     on inv.landed_cost_line (receipt_line_id);

-- cogs_correction now has two sources: an estimated cost that got covered by a receipt
-- ('cover', §3.5) and a landed cost posted or reversed after the sale.
alter table inv.cogs_correction add column if not exists reason text not null default 'cover';
alter table inv.cogs_correction add column if not exists landed_cost_id uuid references inv.landed_cost(id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cogs_correction_reason_chk') then
    alter table inv.cogs_correction add constraint cogs_correction_reason_chk
      check (reason in ('cover','landed_cost','landed_cost_reversal'));
  end if;
end $$;
create index if not exists idx_cogs_corr_landed on inv.cogs_correction (landed_cost_id) where landed_cost_id is not null;

create index if not exists idx_grl_movement  on inv.goods_receipt_line (movement_id);
create index if not exists idx_layer_source  on inv.cost_layer (source_layer_id) where source_layer_id is not null;

-- ---------------------------------------------------------------------------
-- Tracing: from a layer back to the layer the units first arrived in
-- ---------------------------------------------------------------------------
create or replace function inv._root_layer(p_layer bigint) returns bigint
language sql stable as $$
  with recursive up as (
    select id, source_layer_id, 0 as depth from inv.cost_layer where id = p_layer
    union all
    select cl.id, cl.source_layer_id, up.depth + 1
      from inv.cost_layer cl join up on cl.id = up.source_layer_id
  )
  select id from up order by depth desc limit 1
$$;

-- One row per (outbound movement × consumed layer) with where that cost came from.
create or replace view inv.v_consumption_source as
select
  c.id as consumption_id, c.movement_id, m.type as movement_type, m.occurred_at,
  m.item_id, i.sku, i.name as item_name, loc.code as location,
  c.qty, c.unit_cost, round(c.qty * c.unit_cost, 2) as cost, c.estimated,
  case
    when c.layer_id is null             then 'estimated'
    when rm.type = 'purchase_receipt'   then 'purchase'
    when rm.type = 'opening_balance'    then 'opening_balance'
    when rm.type = 'adjustment_in'      then 'adjustment'
    when rm.type = 'sale_return'        then 'sale_return'
    else 'other'
  end as origin,
  c.layer_id, r.root_layer_id, rl.received_at,
  rl.movement_id as origin_movement_id,
  gr.id as receipt_id, gr.number as receipt_number, grl.id as receipt_line_id,
  po.id as po_id, po.number as po_number,
  po.supplier_uuid as supplier_id, coalesce(s.name, po.supplier_name) as supplier_name,
  po.currency as po_currency, grl.unit_cost as po_unit_cost, gr.fx_rate, grl.landed_cost_per_unit,
  case when rl.received_at is not null
       then round((extract(epoch from (m.occurred_at - rl.received_at)) / 86400.0)::numeric, 1) end as days_in_stock
from inv.layer_consumption c
join inv.movement m   on m.id = c.movement_id
join inv.item i       on i.id = m.item_id
join inv.location loc on loc.id = m.location_id
left join lateral (select inv._root_layer(c.layer_id) as root_layer_id) r on true
left join inv.cost_layer rl          on rl.id = r.root_layer_id
left join inv.movement rm            on rm.id = rl.movement_id
left join inv.goods_receipt_line grl on grl.movement_id = rm.id and rm.type = 'purchase_receipt'
left join inv.goods_receipt gr       on gr.id = grl.receipt_id
left join inv.purchase_order po      on po.id = gr.po_id
left join inv.supplier s             on s.id = po.supplier_uuid;

-- Sales and returns mapped to the order line they belong to (reversed movements left out).
--   Woo order  ref_type woo_order, ref_line '<line>', '<line>:<n>' (qty raised / reopened),
--              '<line>:r<n>' (qty lowered / cancelled)                       (spec §7.2)
--   Woo refund ref_type woo_refund, order and line in metadata               (spec §7.3)
--   Manual     record_sale / record_sale_return (metadata.original_ref_* on the return)
create or replace view inv.v_sale_movement as
select
  m.id as movement_id, m.type, m.item_id, m.location_id, m.occurred_at,
  m.qty, m.unit_cost, m.total_cost, m.cost_estimated, m.reference,
  case
    when m.ref_type = 'woo_refund' then 'woo_order'
    when m.type = 'sale_return' and m.metadata ? 'original_ref_type' then m.metadata->>'original_ref_type'
    else m.ref_type
  end as source,
  case
    when m.ref_type = 'woo_refund' then coalesce(m.metadata->>'woo_order_id', ltrim(m.reference, '#'))
    when m.type = 'sale_return' and m.metadata ? 'original_ref_id' then m.metadata->>'original_ref_id'
    else m.ref_id
  end as order_id,
  case
    when m.ref_type = 'woo_refund' then m.metadata->>'woo_line_id'
    when m.type = 'sale_return' and m.metadata ? 'original_ref_id' then m.metadata->>'original_ref_line'
    when m.ref_type = 'woo_order' then split_part(m.ref_line, ':', 1)
    else m.ref_line
  end as line_id
from inv.movement m
where m.type in ('sale', 'sale_return') and m.reversed_by is null;

-- One row per sold order line: what it cost. movement.total_cost is always the current cost
-- (estimates and landed cost are written back to the sale), so nothing is added on top.
create or replace view inv.v_sale_line_cost as
select
  x.source, x.order_id, x.line_id,
  min(x.reference) filter (where x.type = 'sale') as order_ref,
  x.item_id, i.sku, i.name as item_name,
  string_agg(distinct loc.code, ',' order by loc.code) as location,
  coalesce(min(x.occurred_at) filter (where x.type = 'sale'), min(x.occurred_at)) as sold_at,
  coalesce(sum(-x.qty) filter (where x.type = 'sale'), 0) as qty_sold,
  coalesce(sum(x.qty) filter (where x.type = 'sale_return'), 0) as qty_returned,
  coalesce(sum(-x.qty), 0) as qty_net,
  round(coalesce(sum(case when x.type = 'sale' then x.total_cost else -x.total_cost end), 0), 2) as cogs,
  case when sum(-x.qty) > 0
       then round(sum(case when x.type = 'sale' then x.total_cost else -x.total_cost end) / sum(-x.qty), 4) end as unit_cogs,
  coalesce(bool_or(x.cost_estimated) filter (where x.type = 'sale'), false) as cost_estimated,
  (select max(cc.created_at) from inv.cogs_correction cc where cc.movement_id = any(array_agg(x.movement_id))) as last_cost_change_at
from inv.v_sale_movement x
join inv.item i       on i.id = x.item_id
join inv.location loc on loc.id = x.location_id
group by x.source, x.order_id, x.line_id, x.item_id, i.sku, i.name;

-- Where the cost of each sale came from (one row per sale movement × consumed layer).
create or replace view inv.v_sale_cost_source as
select
  s.movement_id, x.source, x.order_id, x.line_id, x.reference as order_ref,
  s.item_id, s.sku, s.item_name, s.location, s.occurred_at as sold_at,
  s.qty, s.unit_cost, s.cost, s.estimated, s.origin,
  s.layer_id, s.root_layer_id, s.received_at, s.origin_movement_id,
  s.receipt_id, s.receipt_number, s.receipt_line_id, s.po_id, s.po_number,
  s.supplier_id, s.supplier_name, s.po_currency, s.po_unit_cost, s.fx_rate, s.landed_cost_per_unit,
  s.days_in_stock
from inv.v_consumption_source s
join inv.v_sale_movement x on x.movement_id = s.movement_id and x.type = 'sale';

-- ---------------------------------------------------------------------------
-- record_sale_return: remember which sale is returned (so the return lands on the order line)
-- ---------------------------------------------------------------------------
create or replace function inv.record_sale_return(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_ref_type text := coalesce(inv._jtext(p, 'ref_type'), 'manual_return');
  v_ref_id   text := inv._jtext(p, 'ref_id');
  v_orig_type text := coalesce(inv._jtext(p, 'original_ref_type'), 'manual_sale');
  v_orig_id   text := inv._jtext(p, 'original_ref_id');
  v_loc      uuid := inv._resolve_location(inv._jtext(p, 'location'));
  e jsonb; v_pos int := 0; v_item uuid; v_qty numeric; v_line text; v_mid bigint;
  v_uc numeric; v_src text; v_cost record;
  v_orig_line text; v_meta jsonb;
  v_out jsonb := '[]';
begin
  if v_ref_id is null then perform inv._raise('VALIDATION', 'ref_id is required'); end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_qty := inv._jnum(e, 'qty');
    if v_qty is null or v_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos)); end if;
    v_line := coalesce(inv._jtext(e, 'ref_line'), v_pos::text);
    v_mid := inv._existing_ref(v_ref_type, v_ref_id, v_line);
    if v_mid is null then
      v_uc := inv._jnum(e, 'unit_cost'); v_src := 'manual';
      if v_uc is null and v_orig_id is not null then
        v_uc := inv._sale_unit_cost(v_item, v_orig_type, v_orig_id, inv._jtext(e, 'original_ref_line'));
        v_src := 'sale_cogs';
      end if;
      if v_uc is null then
        select * into v_cost from inv._resolve_in_cost(v_item, v_loc, null);
        v_uc := v_cost.unit_cost; v_src := v_cost.cost_source;
      end if;
      v_meta := coalesce(p->'metadata', '{}'::jsonb);
      if v_orig_id is not null then
        -- The returned order line: as given, else the (first) line of this item on the sale
        v_orig_line := coalesce(inv._jtext(e, 'original_ref_line'),
          (select min(split_part(s.ref_line, ':', 1)) from inv.movement s
            where s.type = 'sale' and s.ref_type = v_orig_type and s.ref_id = v_orig_id and s.item_id = v_item));
        v_meta := v_meta || jsonb_build_object('original_ref_type', v_orig_type, 'original_ref_id', v_orig_id,
                                               'original_ref_line', v_orig_line);
      end if;
      v_mid := inv._post_in(v_item, v_loc, 'sale_return',
        jsonb_build_array(jsonb_build_object('qty', v_qty, 'unit_cost', v_uc)), v_src,
        v_ref_type, v_ref_id, v_line, coalesce(inv._jtext(p, 'reference'), v_ref_id),
        inv._jtext(p, 'note'), inv._jtext(p, 'by'), inv._jts(p, 'occurred_at'), v_meta);
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', false));
    else
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', true));
    end if;
  end loop;
  return jsonb_build_object('movements', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- Landed cost: move the cost of one receipt line by p_delta per unit, everywhere its units went
-- ---------------------------------------------------------------------------
-- The units of a receipt line are in the layer the receipt created and in every layer derived
-- from it (transfer to another location, reversal of a sale — source_layer_id). All of those
-- layers and all consumption from them get the delta. Then:
--   • outbound movements are re-costed from their consumption rows (as in §3.5)
--   • inbound movements owning a derived layer (transfer_in, reversal) follow their layers
--   • live sales get a cogs_correction row per consumed layer
--   • stock_balance.value is refreshed for every location that holds such a layer
-- Balances for the item are locked first (all locations, fixed order), so no sale or transfer
-- can consume or move the layers while they are being revalued.
create or replace function inv._apply_landed_delta(
  p_receipt_line uuid, p_delta numeric, p_landed_cost uuid, p_reason text,
  out qty_in_stock numeric, out qty_sold numeric, out qty_other numeric,
  out to_stock numeric, out to_cogs numeric, out to_other numeric)
language plpgsql as $$
declare
  grl      inv.goods_receipt_line;
  v_layers bigint[];
  v_outs   bigint[];
begin
  select * into grl from inv.goods_receipt_line where id = p_receipt_line for update;
  if grl.id is null or grl.movement_id is null then
    perform inv._raise('NOT_FOUND', 'goods receipt line not found', jsonb_build_object('receipt_line_id', p_receipt_line));
  end if;

  perform 1 from inv.stock_balance where item_id = grl.item_id order by location_id for update;

  with recursive tree as (
    select id from inv.cost_layer where movement_id = grl.movement_id
    union all
    select cl.id from inv.cost_layer cl join tree t on cl.source_layer_id = t.id
  )
  select coalesce(array_agg(id), '{}') into v_layers from tree;

  if exists (select 1 from inv.cost_layer where id = any(v_layers) and unit_cost + p_delta < 0) then
    perform inv._raise('VALIDATION', 'landed cost would make the unit cost negative',
      jsonb_build_object('receipt_line_id', p_receipt_line, 'delta', p_delta));
  end if;

  select coalesce(sum(qty_remaining), 0), coalesce(round(sum(qty_remaining * p_delta), 2), 0)
    into qty_in_stock, to_stock
    from inv.cost_layer where id = any(v_layers);

  -- Terminal consumption: the units left the stock for good (a live sale, adjustment or
  -- write-off). Transfers and reversed movements only moved the units to another layer.
  select coalesce(sum(c.qty) filter (where m.type = 'sale'), 0),
         coalesce(round(sum(c.qty * p_delta) filter (where m.type = 'sale'), 2), 0),
         coalesce(sum(c.qty) filter (where m.type in ('adjustment_out', 'write_off')), 0),
         coalesce(round(sum(c.qty * p_delta) filter (where m.type in ('adjustment_out', 'write_off')), 2), 0)
    into qty_sold, to_cogs, qty_other, to_other
    from inv.layer_consumption c join inv.movement m on m.id = c.movement_id
   where c.layer_id = any(v_layers) and m.reversed_by is null;

  insert into inv.cogs_correction (movement_id, covered_by_movement_id, qty, estimated_unit_cost, actual_unit_cost,
                                   delta_cost, reason, landed_cost_id)
  select c.movement_id, grl.movement_id, c.qty, c.unit_cost, c.unit_cost + p_delta,
         round(c.qty * p_delta, 2), p_reason, p_landed_cost
    from inv.layer_consumption c join inv.movement m on m.id = c.movement_id
   where c.layer_id = any(v_layers) and m.type = 'sale' and m.reversed_by is null
   order by c.id;

  update inv.cost_layer set unit_cost = unit_cost + p_delta where id = any(v_layers);

  select coalesce(array_agg(distinct movement_id), '{}') into v_outs
    from inv.layer_consumption where layer_id = any(v_layers);
  update inv.layer_consumption set unit_cost = unit_cost + p_delta where layer_id = any(v_layers);

  -- Inbound movements follow their layers (the receipt itself, transfer_in, reversal), costed
  -- the way _post_in does it: Σ layers + the part without a layer (reversal of uncovered consumption).
  update inv.movement m
     set total_cost = round(x.total, 2),
         unit_cost  = round(x.total / m.qty, 4),
         metadata   = case when m.id = grl.movement_id
                           then m.metadata || jsonb_build_object('landed_cost_per_unit', grl.landed_cost_per_unit + p_delta)
                           else m.metadata end
    from (select cl.movement_id,
                 sum(cl.qty_in * cl.unit_cost)
                 + coalesce((select sum(c.qty * c.unit_cost) from inv.layer_consumption c
                              where c.covered_by_movement_id = cl.movement_id and c.layer_id is null), 0) as total
            from inv.cost_layer cl
           where cl.movement_id in (select movement_id from inv.cost_layer where id = any(v_layers))
           group by cl.movement_id) x
   where m.id = x.movement_id;

  -- Outbound movements are re-costed from their consumption rows, the way _post_out does it
  update inv.movement m
     set total_cost = round(s.total, 2), unit_cost = round(s.total / abs(m.qty), 4)
    from (select movement_id, sum(qty * unit_cost) as total
            from inv.layer_consumption where movement_id = any(v_outs) group by 1) s
   where m.id = s.movement_id;

  update inv.goods_receipt_line
     set landed_cost_per_unit = landed_cost_per_unit + p_delta,
         unit_cost_base       = unit_cost_base + p_delta
   where id = grl.id;

  update inv.stock_balance b
     set value = inv._layer_value(b.item_id, b.location_id), updated_at = now()
   where b.item_id = grl.item_id
     and b.location_id in (select location_id from inv.cost_layer where id = any(v_layers));
end $$;

-- ---------------------------------------------------------------------------
-- Landed cost document
-- ---------------------------------------------------------------------------
create or replace function inv._landed_cost_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(lc)
         || jsonb_build_object(
              'rounding_diff', lc.amount_base - lc.applied_base,
              'receipts', coalesce((
                 select jsonb_agg(jsonb_build_object('id', y.id, 'number', y.number, 'po_id', y.po_id,
                                                    'po_number', y.po_number, 'supplier_name', y.supplier_name) order by y.number)
                 from (select distinct gr.id, gr.number, po.id as po_id, po.number as po_number, po.supplier_name
                         from inv.landed_cost_line l
                         join inv.goods_receipt gr on gr.id = l.receipt_id
                         join inv.purchase_order po on po.id = gr.po_id
                        where l.landed_cost_id = lc.id) y), '[]'::jsonb),
              'lines', coalesce((
                 select jsonb_agg(to_jsonb(l) - 'landed_cost_id' - 'item_id'
                          || jsonb_build_object('sku', i.sku, 'item_name', i.name, 'receipt_number', gr.number) order by l.position)
                 from inv.landed_cost_line l
                 join inv.item i on i.id = l.item_id
                 join inv.goods_receipt gr on gr.id = l.receipt_id
                 where l.landed_cost_id = lc.id), '[]'::jsonb))
  from inv.landed_cost lc where lc.id = p_id
$$;

-- p: { amount, currency?, fx_rate?, method?: value|qty|manual, description?, vendor?, invoice_ref?,
--      occurred_at?, note?, by?,
--      receipts?: [receipt id | number, …], po?: po id | number,
--      lines?: [{ receipt_line_id | (receipt + sku), amount }] }        -- method manual
--   value   split by goods value (qty × price × receipt fx) — the default
--   qty     split by number of units
--   manual  the amount per receipt line is given (document currency)
create or replace function inv.create_landed_cost(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_base     text := coalesce(inv._setting('base_currency'), 'NOK');
  v_currency text := upper(coalesce(inv._jtext(p, 'currency'), v_base));
  v_fx       numeric := inv._jnum(p, 'fx_rate');
  v_amount   numeric := inv._jnum(p, 'amount');
  v_method   text := lower(coalesce(inv._jtext(p, 'method'), case when jsonb_typeof(p->'lines') = 'array' then 'manual' else 'value' end));
  v_amount_base numeric;
  v_sum      numeric;
  v_ref      text;
  v_po       inv.purchase_order;
  v_gr       inv.goods_receipt;
  g          inv.goods_receipt_line;
  v_receipts uuid[] := '{}';
  v_lc       uuid;
  v_total_basis numeric;
  v_left     numeric;
  v_alloc    numeric;
  v_delta    numeric;
  v_pos      int := 0;
  v_n        int;
  e          jsonb;
  a          record;
  r          record;
begin
  if v_method not in ('value', 'qty', 'manual') then
    perform inv._raise('VALIDATION', 'method must be value, qty or manual', jsonb_build_object('field', 'method'));
  end if;
  if v_currency = v_base then
    v_fx := 1;
  elsif v_fx is null then
    perform inv._raise('VALIDATION', format('fx_rate is required for %s', v_currency), jsonb_build_object('field', 'fx_rate'));
  elsif v_fx <= 0 then
    perform inv._raise('VALIDATION', 'fx_rate must be > 0', jsonb_build_object('field', 'fx_rate'));
  end if;

  if v_method = 'manual' then
    if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
      perform inv._raise('VALIDATION', 'lines must be a non-empty array when method is manual', jsonb_build_object('field', 'lines'));
    end if;
    if exists (select 1 from jsonb_array_elements(p->'lines') x where inv._jnum(x, 'amount') is null or inv._jnum(x, 'amount') < 0) then
      perform inv._raise('VALIDATION', 'every line needs an amount >= 0', jsonb_build_object('field', 'lines'));
    end if;
    select sum(inv._jnum(x, 'amount')), sum(round(inv._jnum(x, 'amount') * v_fx, 2)) into v_sum, v_amount_base
      from jsonb_array_elements(p->'lines') x;
    if v_amount is not null and v_amount <> v_sum then
      perform inv._raise('VALIDATION', 'amount does not equal the sum of the lines', jsonb_build_object('field', 'amount', 'sum', v_sum));
    end if;
    v_amount := v_sum;
  else
    v_amount_base := round(v_amount * v_fx, 2);
  end if;
  if v_amount is null or v_amount <= 0 or v_amount_base <= 0 then
    perform inv._raise('VALIDATION', 'amount must be > 0', jsonb_build_object('field', 'amount'));
  end if;

  insert into inv.landed_cost (number, description, vendor, invoice_ref, currency, fx_rate, amount, amount_base,
                               method, occurred_at, note, created_by)
  values ('LC-' || lpad(nextval('inv.lc_number_seq')::text, 6, '0'),
          inv._jtext(p, 'description'), inv._jtext(p, 'vendor'), inv._jtext(p, 'invoice_ref'),
          v_currency, v_fx, v_amount, v_amount_base, v_method,
          coalesce(inv._jts(p, 'occurred_at'), now()), inv._jtext(p, 'note'), inv._jtext(p, 'by'))
  returning id into v_lc;

  -- 1) Target lines (unit_delta and the cost columns are filled in step 3)
  if v_method = 'manual' then
    for e in select * from jsonb_array_elements(p->'lines') loop
      v_pos := v_pos + 1;
      g := null;
      if inv._jtext(e, 'receipt_line_id') is not null then
        select * into g from inv.goods_receipt_line where id = inv._to_uuid(inv._jtext(e, 'receipt_line_id'));
      elsif inv._jtext(e, 'receipt') is not null and inv._jtext(e, 'sku') is not null then
        select grl.* into g
          from inv.goods_receipt_line grl join inv.goods_receipt gr on gr.id = grl.receipt_id
         where (gr.id = inv._to_uuid(inv._jtext(e, 'receipt')) or gr.number = inv._jtext(e, 'receipt'))
           and grl.item_id = inv._resolve_item(inv._jtext(e, 'sku'))
         order by grl.created_at, grl.id limit 1;
      end if;
      if g.id is null then
        perform inv._raise('NOT_FOUND', 'goods receipt line not found',
          jsonb_build_object('line', v_pos, 'receipt_line_id', e->>'receipt_line_id', 'receipt', e->>'receipt', 'sku', e->>'sku'));
      end if;
      select * into v_gr from inv.goods_receipt where id = g.receipt_id;
      if v_gr.status <> 'completed' or exists (select 1 from inv.movement m where m.id = g.movement_id and m.reversed_by is not null) then
        perform inv._raise('VALIDATION', format('goods receipt %s is reversed', v_gr.number), jsonb_build_object('line', v_pos));
      end if;
      if exists (select 1 from inv.landed_cost_line where landed_cost_id = v_lc and receipt_line_id = g.id) then
        perform inv._raise('VALIDATION', 'the same receipt line is listed twice', jsonb_build_object('line', v_pos));
      end if;
      insert into inv.landed_cost_line (landed_cost_id, receipt_id, receipt_line_id, item_id, movement_id, qty, basis,
                                        amount_base, unit_delta, unit_cost_before, unit_cost_after)
      values (v_lc, g.receipt_id, g.id, g.item_id, g.movement_id, g.qty, round(inv._jnum(e, 'amount') * v_fx, 2),
              round(inv._jnum(e, 'amount') * v_fx, 2), 0, g.unit_cost_base, g.unit_cost_base);
    end loop;
  else
    if jsonb_typeof(p->'receipts') = 'array' then
      for v_ref in select jsonb_array_elements_text(p->'receipts') loop
        select * into v_gr from inv.goods_receipt where id = inv._to_uuid(v_ref) or number = v_ref;
        if v_gr.id is null then
          perform inv._raise('NOT_FOUND', format('goods receipt %s not found', v_ref), jsonb_build_object('receipt', v_ref));
        end if;
        if v_gr.status <> 'completed' then
          perform inv._raise('VALIDATION', format('goods receipt %s is reversed', v_gr.number), jsonb_build_object('receipt', v_ref));
        end if;
        v_receipts := v_receipts || v_gr.id;
      end loop;
    end if;
    v_ref := coalesce(inv._jtext(p, 'po'), inv._jtext(p, 'po_id'), inv._jtext(p, 'po_number'));
    if v_ref is not null then
      select * into v_po from inv.purchase_order where id = inv._to_uuid(v_ref) or number = v_ref;
      if v_po.id is null then
        perform inv._raise('PO_NOT_FOUND', format('purchase order %s not found', v_ref), jsonb_build_object('po', v_ref));
      end if;
      v_receipts := v_receipts || coalesce(
        (select array_agg(id) from inv.goods_receipt where po_id = v_po.id and status = 'completed'), '{}');
    end if;
    if cardinality(v_receipts) = 0 then
      perform inv._raise('VALIDATION', 'give receipts (ids or numbers) or po — or lines with method manual',
        jsonb_build_object('field', 'receipts'));
    end if;

    insert into inv.landed_cost_line (landed_cost_id, receipt_id, receipt_line_id, item_id, movement_id, qty, basis,
                                      amount_base, unit_delta, unit_cost_before, unit_cost_after)
    select v_lc, grl.receipt_id, grl.id, grl.item_id, grl.movement_id, grl.qty,
           case when v_method = 'qty' then grl.qty else round(grl.qty * grl.unit_cost * gr.fx_rate, 4) end,
           0, 0, grl.unit_cost_base, grl.unit_cost_base
      from inv.goods_receipt_line grl
      join inv.goods_receipt gr on gr.id = grl.receipt_id
      join inv.movement m on m.id = grl.movement_id
     where grl.receipt_id = any(v_receipts) and gr.status = 'completed' and m.reversed_by is null;

    select count(*), coalesce(sum(basis), 0) into v_n, v_total_basis from inv.landed_cost_line where landed_cost_id = v_lc;
    if v_n = 0 then
      perform inv._raise('VALIDATION', 'the receipts have no lines to allocate to');
    end if;
    if v_total_basis <= 0 then
      perform inv._raise('VALIDATION', 'the goods value of the receipts is 0 — allocate by qty instead',
        jsonb_build_object('field', 'method'));
    end if;
    -- 2) Proportional split in whole øre; the largest line takes the remainder
    v_left := v_amount_base;
    for a in select id, basis, row_number() over (order by basis, id) as rn
               from inv.landed_cost_line where landed_cost_id = v_lc order by 3 loop
      v_alloc := case when a.rn = v_n then v_left else round(v_amount_base * a.basis / v_total_basis, 2) end;
      update inv.landed_cost_line set amount_base = v_alloc where id = a.id;
      v_left := v_left - v_alloc;
    end loop;
  end if;

  -- 3) Apply, item by item in a fixed order (lock order)
  v_pos := 0;
  for a in
    select l.id, l.receipt_line_id, l.amount_base, l.qty, l.unit_cost_before
      from inv.landed_cost_line l join inv.goods_receipt gr on gr.id = l.receipt_id
     where l.landed_cost_id = v_lc
     order by l.item_id, gr.number, l.receipt_line_id
  loop
    v_pos := v_pos + 1;
    v_delta := round(a.amount_base / a.qty, 4);
    select * into r from inv._apply_landed_delta(a.receipt_line_id, v_delta, v_lc, 'landed_cost');
    update inv.landed_cost_line
       set position = v_pos, unit_delta = v_delta, unit_cost_after = a.unit_cost_before + v_delta,
           qty_in_stock = r.qty_in_stock, qty_sold = r.qty_sold, qty_other = r.qty_other,
           to_stock = r.to_stock, to_cogs = r.to_cogs, to_other = r.to_other
     where id = a.id;
  end loop;

  update inv.landed_cost lc
     set applied_base = x.applied, to_stock = x.to_stock, to_cogs = x.to_cogs, to_other = x.to_other
    from (select round(sum(qty * unit_delta), 2) as applied, sum(to_stock) as to_stock,
                 sum(to_cogs) as to_cogs, sum(to_other) as to_other
            from inv.landed_cost_line where landed_cost_id = v_lc) x
   where lc.id = v_lc;

  return inv._landed_cost_json(v_lc);
end $$;

-- Same input as create_landed_cost; runs it and rolls back (numbers are used, nothing is stored).
create or replace function inv.preview_landed_cost(p jsonb) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := inv.create_landed_cost(p);
    raise exception 'INV_PREVIEW_ROLLBACK' using errcode = 'IVPRV';
  exception when sqlstate 'IVPRV' then
    null;
  end;
  return v || jsonb_build_object('preview', true);
end $$;

create or replace function inv.reverse_landed_cost(p_id uuid, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare lc inv.landed_cost; l record; r record;
begin
  select * into lc from inv.landed_cost where id = p_id for update;
  if lc.id is null then perform inv._raise('NOT_FOUND', 'landed cost not found'); end if;
  if lc.status = 'reversed' then perform inv._raise('ALREADY_REVERSED', 'landed cost is already reversed'); end if;
  for l in select * from inv.landed_cost_line where landed_cost_id = lc.id order by item_id, position loop
    select * into r from inv._apply_landed_delta(l.receipt_line_id, -l.unit_delta, lc.id, 'landed_cost_reversal');
  end loop;
  update inv.landed_cost
     set status = 'reversed', reversed_at = now(), reversed_by = p_by, reverse_note = p_note
   where id = lc.id;
  return inv._landed_cost_json(lc.id);
end $$;

-- ---------------------------------------------------------------------------
-- reverse_goods_receipt: a receipt with a posted landed cost cannot be reversed
-- ---------------------------------------------------------------------------
create or replace function inv.reverse_goods_receipt(p_id uuid, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare gr inv.goods_receipt; po inv.purchase_order; r record; v_lc text;
begin
  select * into gr from inv.goods_receipt where id = p_id for update;
  if gr.id is null then perform inv._raise('NOT_FOUND', 'goods receipt not found'); end if;
  if gr.status = 'reversed' then perform inv._raise('ALREADY_REVERSED', 'goods receipt is already reversed'); end if;
  select string_agg(distinct lc.number, ', ') into v_lc
    from inv.landed_cost_line l join inv.landed_cost lc on lc.id = l.landed_cost_id
   where l.receipt_id = gr.id and lc.status = 'posted';
  if v_lc is not null then
    perform inv._raise('LANDED_COST_POSTED',
      format('goods receipt %s has landed cost %s — reverse the landed cost first', gr.number, v_lc),
      jsonb_build_object('receipt', gr.number, 'landed_costs', v_lc));
  end if;
  po := inv._lock_po(gr.po_id);
  if po.status in ('closed','cancelled') then
    perform inv._raise('PO_STATUS_INVALID', format('purchase order is %s', po.status));
  end if;
  for r in select * from inv.goods_receipt_line where receipt_id = gr.id order by created_at desc, id loop
    perform inv._reverse(r.movement_id, p_by, coalesce(p_note, 'Reversering av ' || gr.number));
    update inv.purchase_order_line set qty_received = qty_received - r.qty where id = r.po_line_id;
  end loop;
  update inv.goods_receipt set status = 'reversed' where id = gr.id;
  perform inv._po_recompute_status(po.id);
  return inv._receipt_json(gr.id);
end $$;

-- ---------------------------------------------------------------------------
-- Grants (same rule as 0006: inv is server-only)
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema inv from %I', r);
      execute format('revoke all on all sequences in schema inv from %I', r);
      execute format('revoke all on all functions in schema inv from %I', r);
    end if;
  end loop;
end $$;

update inv.settings set value = '0.12.0', updated_at = now() where key = 'schema_version';

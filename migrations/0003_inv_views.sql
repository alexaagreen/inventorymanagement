-- inventory-ledger v0.1.0
-- =============================================================================
-- 0003_inv_views.sql — lesemodell (spec §2.12)
-- =============================================================================

create or replace view inv.v_stock_by_location as
select
  b.item_id, i.sku, i.name as item_name,
  b.location_id, l.code as location_code, l.sellable_online,
  b.on_hand, b.value,
  case when b.on_hand > 0 then round(b.value / b.on_hand, 4) end as avg_cost,
  b.last_movement_at
from inv.stock_balance b
join inv.item i on i.id = b.item_id
join inv.location l on l.id = b.location_id;

create or replace view inv.v_item_status as
with bal as (
  select b.item_id,
         sum(b.on_hand) as on_hand,
         sum(b.on_hand) filter (where l.sellable_online) as on_hand_sellable,
         sum(b.value) as stock_value,
         max(b.last_movement_at) as last_movement_at,
         jsonb_agg(jsonb_build_object('code', l.code, 'on_hand', b.on_hand, 'value', b.value,
                                      'avg_cost', case when b.on_hand > 0 then round(b.value / b.on_hand, 4) end)
                   order by l.code) as locations
  from inv.stock_balance b join inv.location l on l.id = b.location_id
  group by b.item_id
),
ord as (
  select pl.item_id,
         sum(greatest(pl.qty_ordered - pl.qty_received, 0)) as on_order,
         min(po.expected_at) filter (where pl.qty_ordered > pl.qty_received) as next_delivery
  from inv.purchase_order_line pl
  join inv.purchase_order po on po.id = pl.po_id
  where po.status in ('sent','partially_received')
  group by pl.item_id
),
lastp as (
  select distinct on (item_id) item_id, unit_cost as last_purchase_cost, occurred_at as last_purchase_at
  from inv.movement
  where type = 'purchase_receipt' and reversed_by is null
  order by item_id, occurred_at desc, id desc
),
opn as (
  select m.item_id, sum(c.qty) as open_consumption_qty
  from inv.layer_consumption c join inv.movement m on m.id = c.movement_id
  where c.layer_id is null and c.covered_by_movement_id is null
  group by m.item_id
)
select
  i.id as item_id, i.sku, i.name, i.woo_product_id, i.woo_variation_id,
  i.track_stock, i.active, i.reorder_point, i.reorder_qty, i.attributes,
  coalesce(bal.on_hand, 0) as on_hand,
  coalesce(bal.on_hand_sellable, 0) as on_hand_sellable,
  0::numeric as allocated,
  coalesce(bal.on_hand_sellable, 0) - 0 as available,
  coalesce(ord.on_order, 0) as on_order,
  ord.next_delivery,
  coalesce(bal.stock_value, 0) as stock_value,
  case when coalesce(bal.on_hand, 0) > 0 then round(bal.stock_value / bal.on_hand, 4) end as avg_cost,
  lastp.last_purchase_cost, lastp.last_purchase_at,
  bal.last_movement_at,
  coalesce(bal.on_hand, 0) < 0 as negative,
  (i.reorder_point is not null and coalesce(bal.on_hand, 0) <= i.reorder_point) as below_reorder,
  coalesce(opn.open_consumption_qty, 0) as open_consumption_qty,
  coalesce(bal.locations, '[]'::jsonb) as locations
from inv.item i
left join bal on bal.item_id = i.id
left join ord on ord.item_id = i.id
left join lastp on lastp.item_id = i.id
left join opn on opn.item_id = i.id;

create or replace view inv.v_movement as
select
  m.id, m.occurred_at, m.created_at,
  m.item_id, i.sku, i.name as item_name,
  m.location_id, l.code as location,
  m.type,
  case
    when m.type in ('purchase_receipt','opening_balance') then 'innkjop'
    when m.type in ('sale','sale_return') then 'salg'
    when m.type in ('adjustment_in','adjustment_out','write_off') then 'justering'
    when m.type in ('transfer_in','transfer_out') then 'flytting'
    else 'reversering'
  end as kind,
  m.qty, m.unit_cost, m.total_cost, m.cost_estimated, m.cost_source, m.on_hand_after,
  m.ref_type, m.ref_id, m.ref_line, m.reference, m.note, m.created_by,
  m.reversal_of, m.reversed_by, (m.reversed_by is not null) as is_reversed,
  m.metadata
from inv.movement m
join inv.item i on i.id = m.item_id
join inv.location l on l.id = m.location_id;

create or replace view inv.v_open_consumption as
select c.id as consumption_id, m.id as movement_id, m.occurred_at,
       i.sku, l.code as location, c.qty, c.unit_cost as estimated_unit_cost,
       m.ref_type, m.ref_id, m.reference
from inv.layer_consumption c
join inv.movement m on m.id = c.movement_id
join inv.item i on i.id = m.item_id
join inv.location l on l.id = m.location_id
where c.layer_id is null and c.covered_by_movement_id is null;

-- Status for én vare som jsonb (GET /stock/:sku)
create or replace function inv.get_item_status(p_sku text) returns jsonb
language sql stable as $$
  select to_jsonb(s)
         || jsonb_build_object('layers', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', cl.id, 'location', l.code, 'received_at', cl.received_at,
                       'qty_in', cl.qty_in, 'qty_remaining', cl.qty_remaining, 'unit_cost', cl.unit_cost,
                       'movement_id', cl.movement_id, 'reference', m.reference)
                     order by cl.received_at, cl.id)
              from inv.cost_layer cl
              join inv.location l on l.id = cl.location_id
              join inv.movement m on m.id = cl.movement_id
              where cl.item_id = s.item_id and cl.qty_remaining > 0), '[]'::jsonb))
  from inv.v_item_status s
  where s.item_id = inv._resolve_item(p_sku)
$$;

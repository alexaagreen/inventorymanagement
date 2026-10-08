-- inventory-ledger v0.6.0
-- =============================================================================
-- 0004_inv_woo.sql — Woo core in SQL (spec §2.11, §5.5, §7)
-- =============================================================================
-- Plain Postgres, no network. The HTTP layer (api/lib/inventory/woo-*.js) fetches
-- data from Woo and pushes stock; the state machine and the queue live here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists inv.woo_order_sync (
  woo_order_id   bigint primary key,
  woo_status     text,
  stock_state    text not null default 'none' check (stock_state in ('none','deducted','restored')),
  location_id    uuid references inv.location(id),
  -- Per line: {line_id, item_id, sku, ordered, net, refunded, seq}
  --   ordered  = quantity last seen on the order line
  --   net      = net quantity taken from stock for the line (sales − returns)
  --   refunded = quantity returned via Woo refunds
  --   seq      = counter for unique ref_line values on later movements
  lines          jsonb not null default '[]',
  refunds        jsonb not null default '[]',
  unmatched      jsonb not null default '[]',
  last_payload   jsonb,
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists trg_woo_order_sync_updated on inv.woo_order_sync;
create trigger trg_woo_order_sync_updated before update on inv.woo_order_sync
  for each row execute function inv.set_updated_at();

create table if not exists inv.stock_push_queue (
  item_id          uuid primary key references inv.item(id),
  requested_at     timestamptz not null default now(),
  claimed_until    timestamptz,
  last_pushed_qty  numeric(14,3),
  last_pushed_at   timestamptz,
  last_result      text,          -- ok | error | skipped
  attempts         int not null default 0,
  last_error       text,
  next_attempt_at  timestamptz
);
create index if not exists idx_push_due on inv.stock_push_queue (requested_at)
  where last_pushed_at is null or requested_at > last_pushed_at;

create table if not exists inv.woo_webhook_log (
  id           bigserial primary key,
  topic        text,
  resource_id  text,
  received_at  timestamptz not null default now(),
  result       text not null check (result in ('applied','ignored','error')),
  message      text
);
create index if not exists idx_woo_webhook_log_time on inv.woo_webhook_log (received_at desc);

-- ---------------------------------------------------------------------------
-- Push queue: every movement and relevant item change asks for a push
-- ---------------------------------------------------------------------------
create or replace function inv.enqueue_stock_push_trg() returns trigger
language plpgsql as $$
begin
  insert into inv.stock_push_queue (item_id, requested_at)
  values (new.item_id, clock_timestamp())
  on conflict (item_id) do update set requested_at = clock_timestamp();
  return null;
end $$;
drop trigger if exists trg_movement_enqueue_push on inv.movement;
create trigger trg_movement_enqueue_push after insert on inv.movement
  for each row execute function inv.enqueue_stock_push_trg();

create or replace function inv.enqueue_item_push_trg() returns trigger
language plpgsql as $$
begin
  if (new.track_stock, new.woo_product_id, new.woo_variation_id, new.active)
     is distinct from (old.track_stock, old.woo_product_id, old.woo_variation_id, old.active) then
    insert into inv.stock_push_queue (item_id, requested_at)
    values (new.id, clock_timestamp())
    on conflict (item_id) do update set requested_at = clock_timestamp();
  end if;
  return null;
end $$;
drop trigger if exists trg_item_enqueue_push on inv.item;
create trigger trg_item_enqueue_push after update on inv.item
  for each row execute function inv.enqueue_item_push_trg();

-- Ask for a push explicitly (reconcile/fix). p_skus null = every tracked item with a Woo id.
create or replace function inv.enqueue_stock_push(p_skus text[] default null) returns jsonb
language plpgsql as $$
declare n int;
begin
  insert into inv.stock_push_queue (item_id, requested_at)
  select id, clock_timestamp() from inv.item
   where track_stock and woo_product_id is not null
     and (p_skus is null or upper(btrim(sku)) = any (select upper(btrim(s)) from unnest(p_skus) s))
  on conflict (item_id) do update set requested_at = clock_timestamp(), next_attempt_at = null;
  get diagnostics n = row_count;
  return jsonb_build_object('enqueued', n);
end $$;

-- Fetch and claim items that should be pushed. The claim (2 min) stops parallel
-- workers from taking the same item. Items that cannot be pushed are marked skipped.
create or replace function inv.list_stock_push_due(p_limit int default 100) returns jsonb
language plpgsql as $$
declare
  v_floor boolean := inv._setting_bool('woo_push_floor_zero');
  v jsonb;
begin
  -- Not pushable: mark skipped
  update inv.stock_push_queue q
     set last_pushed_at = clock_timestamp(), last_result = 'skipped',
         last_error = case when not i.track_stock then 'track_stock=false'
                           when i.woo_product_id is null then 'no woo_product_id'
                           else 'inactive' end,
         claimed_until = null
    from inv.item i
   where i.id = q.item_id
     and (q.last_pushed_at is null or q.requested_at > q.last_pushed_at)
     and (not i.track_stock or i.woo_product_id is null or not i.active);

  with due as (
    select q.item_id
      from inv.stock_push_queue q
     where (q.last_pushed_at is null or q.requested_at > q.last_pushed_at)
       and (q.next_attempt_at is null or q.next_attempt_at <= now())
       and (q.claimed_until is null or q.claimed_until < now())
     order by q.requested_at
     limit greatest(p_limit, 1)
     for update skip locked
  ),
  claimed as (
    update inv.stock_push_queue q set claimed_until = now() + interval '2 minutes'
      from due where q.item_id = due.item_id
    returning q.item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', s.item_id, 'sku', s.sku,
           'woo_product_id', s.woo_product_id, 'woo_variation_id', s.woo_variation_id,
           'available', s.available,
           'qty_to_push', case when v_floor then greatest(floor(s.available), 0) else floor(s.available) end)
           order by s.sku), '[]'::jsonb)
    into v
    from claimed c join inv.v_item_status s on s.item_id = c.item_id;
  return v;
end $$;

create or replace function inv.mark_stock_pushed(p_item_id uuid, p_qty numeric, p_ok boolean, p_error text default null)
returns void language plpgsql as $$
begin
  if p_ok then
    update inv.stock_push_queue
       set last_pushed_qty = p_qty, last_pushed_at = clock_timestamp(), last_result = 'ok',
           attempts = 0, last_error = null, next_attempt_at = null, claimed_until = null
     where item_id = p_item_id;
  else
    update inv.stock_push_queue
       set attempts = attempts + 1, last_result = 'error', last_error = left(p_error, 1000),
           next_attempt_at = now() + least(power(2, attempts + 1), 60) * interval '1 minute',
           claimed_until = null
     where item_id = p_item_id;
  end if;
end $$;

create or replace function inv.stock_push_status() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'queue_size', (select count(*) from inv.stock_push_queue
                    where last_pushed_at is null or requested_at > last_pushed_at),
    'oldest_requested_at', (select min(requested_at) from inv.stock_push_queue
                    where last_pushed_at is null or requested_at > last_pushed_at),
    'last_push_at', (select max(last_pushed_at) from inv.stock_push_queue where last_result = 'ok'),
    'failed_items', coalesce((select jsonb_agg(jsonb_build_object(
                       'sku', i.sku, 'attempts', q.attempts, 'last_error', q.last_error,
                       'next_attempt_at', q.next_attempt_at) order by q.attempts desc)
                     from inv.stock_push_queue q join inv.item i on i.id = q.item_id
                     where q.last_result = 'error'), '[]'::jsonb),
    'skipped_items', (select count(*) from inv.stock_push_queue where last_result = 'skipped'))
$$;

-- ---------------------------------------------------------------------------
-- Webhook log (30-day retention)
-- ---------------------------------------------------------------------------
create or replace function inv.log_woo_webhook(p_topic text, p_resource_id text, p_result text, p_message text default null)
returns void language plpgsql as $$
begin
  insert into inv.woo_webhook_log (topic, resource_id, result, message)
  values (p_topic, p_resource_id, p_result, left(p_message, 2000));
  if random() < 0.02 then
    delete from inv.woo_webhook_log where received_at < now() - interval '30 days';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Items in bulk (Woo products/variations → inv.item)
-- p: { items: [ {sku, woo_product_id, woo_variation_id, name, track_stock, active}, … ],
--      deactivate_missing: bool }   — deactivate_missing only for a full catalog.
-- ---------------------------------------------------------------------------
create or replace function inv.upsert_items(p jsonb) returns jsonb
language plpgsql as $$
declare
  e jsonb; v_ok int := 0; v_skipped jsonb := '[]'; v_deact int := 0; v_ids uuid[] := '{}';
  r jsonb;
begin
  if jsonb_typeof(p->'items') <> 'array' then perform inv._raise('VALIDATION', 'items must be an array'); end if;
  for e in select * from jsonb_array_elements(p->'items') loop
    if inv._jtext(e, 'sku') is null then
      v_skipped := v_skipped || jsonb_build_object('reason', 'missing sku',
        'woo_product_id', e->'woo_product_id', 'woo_variation_id', e->'woo_variation_id', 'name', e->'name');
      continue;
    end if;
    begin
      r := inv.upsert_item(e);
      v_ids := v_ids || (r->>'id')::uuid;
      v_ok := v_ok + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('reason', sqlerrm, 'sku', e->>'sku');
    end;
  end loop;
  if coalesce((p->>'deactivate_missing')::boolean, false) then
    update inv.item set active = false
     where active and woo_product_id is not null and not (id = any (v_ids));
    get diagnostics v_deact = row_count;
  end if;
  return jsonb_build_object('upserted', v_ok, 'deactivated', v_deact, 'skipped', v_skipped);
end $$;

-- ---------------------------------------------------------------------------
-- Order → sale (spec §7.2)
-- ---------------------------------------------------------------------------
create or replace function inv._csv_has(p_csv text, p_val text) returns boolean
language sql immutable as $$
  select p_val = any (string_to_array(replace(coalesce(p_csv, ''), ' ', ''), ','))
$$;

create or replace function inv._woo_ts(p text) returns timestamptz
language plpgsql immutable as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  if p ~ '(Z|[+-]\d\d:?\d\d)$' then return p::timestamptz; end if;
  return (p || 'Z')::timestamptz;   -- Woo *_gmt fields have no timezone
exception when others then return null;
end $$;

-- Resolve an item for a Woo line: (product_id, variation_id) first, then SKU.
create or replace function inv._woo_line_item(li jsonb) returns uuid
language plpgsql stable as $$
declare
  v_pid bigint := nullif(li->>'product_id', '')::bigint;
  v_vid bigint := nullif(nullif(li->>'variation_id', ''), '0')::bigint;
  v uuid;
begin
  if v_pid is not null and v_pid <> 0 then
    if v_vid is not null then
      select id into v from inv.item where woo_variation_id = v_vid and woo_product_id = v_pid;
      if v is null then select id into v from inv.item where woo_variation_id = v_vid; end if;
    else
      select id into v from inv.item where woo_product_id = v_pid and woo_variation_id is null;
    end if;
  end if;
  if v is null and nullif(btrim(li->>'sku'), '') is not null then
    select id into v from inv.item where upper(btrim(sku)) = inv._norm_sku(li->>'sku');
  end if;
  return v;
end $$;

create or replace function inv._woo_order_location(o jsonb) returns uuid
language plpgsql stable as $$
declare v_code text;
begin
  select m->>'value' into v_code from jsonb_array_elements(coalesce(o->'meta_data', '[]')) m
   where m->>'key' = 'inv_location' limit 1;
  begin
    return inv._resolve_location(v_code);
  exception when others then
    return inv._resolve_location(null);  -- unknown code → default, do not fail the order
  end;
end $$;

create or replace function inv.apply_woo_order(o jsonb, p_source text default 'webhook') returns jsonb
language plpgsql as $$
declare
  v_order   bigint := (o->>'id')::bigint;
  v_status  text := o->>'status';
  v_ref     text;
  s         inv.woo_order_sync;
  v_deduct  boolean;
  v_restore boolean;
  v_loc     uuid;
  v_allow   boolean := inv._setting_bool('allow_negative_sale');
  v_by      text := 'system:woo-' || coalesce(p_source, 'webhook');
  v_number  text := coalesce(o->>'number', o->>'id');
  v_created timestamptz := coalesce(inv._woo_ts(o->>'date_created_gmt'), inv._woo_ts(o->>'date_created'));
  -- desired: line_id → {item_id, sku, qty}
  v_desired  jsonb := '{}';
  v_unmatched jsonb := '[]';
  v_lines   jsonb;          -- line_id → snapshot entry
  li        jsonb;
  v_line_id text;
  v_item    uuid;
  e         jsonb;
  v_want    numeric;
  v_ord     numeric;
  v_net     numeric;
  v_ref_qty numeric;
  v_seq     int;
  v_delta   numeric;
  v_mid     bigint;
  v_mids    bigint[] := '{}';
  v_action  text := 'ignored';
  v_uc      numeric;
  k         text;
begin
  if v_order is null then perform inv._raise('VALIDATION', 'order id is required'); end if;
  v_ref := v_order::text;
  v_deduct  := inv._csv_has(inv._setting('deduct_statuses'), v_status);
  v_restore := inv._csv_has(inv._setting('restore_statuses'), v_status);

  insert into inv.woo_order_sync (woo_order_id) values (v_order) on conflict do nothing;
  select * into s from inv.woo_order_sync where woo_order_id = v_order for update;

  v_loc := coalesce(s.location_id, inv._woo_order_location(o));

  -- Desired state from the payload
  for li in select * from jsonb_array_elements(coalesce(o->'line_items', '[]')) loop
    v_line_id := li->>'id';
    if v_line_id is null or coalesce((li->>'quantity')::numeric, 0) <= 0 then continue; end if;
    v_item := inv._woo_line_item(li);
    if v_item is null then
      v_unmatched := v_unmatched || jsonb_build_object('line_id', v_line_id, 'sku', li->>'sku',
        'product_id', li->'product_id', 'variation_id', li->'variation_id', 'name', li->>'name',
        'quantity', (li->>'quantity')::numeric);
      continue;
    end if;
    v_desired := v_desired || jsonb_build_object(v_line_id,
      jsonb_build_object('item_id', v_item, 'sku', inv._sku(v_item), 'qty', (li->>'quantity')::numeric));
  end loop;

  -- Snapshot as a map line_id → entry
  select coalesce(jsonb_object_agg(x->>'line_id', x), '{}') into v_lines
    from jsonb_array_elements(s.lines) x;

  if v_deduct then
    -- Applies to none → deducted, restored → deducted, and a diff while deducted.
    for k in select key from (
               select jsonb_object_keys(v_desired) as key
               union select jsonb_object_keys(v_lines)) z
             order by length(key), key
    loop
      e := coalesce(v_lines->k, jsonb_build_object('line_id', k, 'item_id', v_desired->k->>'item_id',
             'sku', v_desired->k->>'sku', 'ordered', 0, 'net', 0, 'refunded', 0, 'seq', 0));
      v_item := (e->>'item_id')::uuid;
      v_want := coalesce((v_desired->k->>'qty')::numeric, 0);
      v_ord  := (e->>'ordered')::numeric;
      v_net  := (e->>'net')::numeric;
      v_seq  := (e->>'seq')::int;
      -- Target: net = ordered − refunded (refunded units must not be deducted again)
      v_delta := greatest(v_want - (e->>'refunded')::numeric, 0) - v_net;

      if v_delta > 0 then
        v_mid := inv._post_out(v_item, v_loc, 'sale', v_delta, v_allow,
          'woo_order', v_ref, case when v_seq = 0 then k else k || ':' || v_seq end,
          '#' || v_number, null, v_by,
          case when s.stock_state = 'none' and v_seq = 0 then coalesce(v_created, now()) else now() end,
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_net := v_net + v_delta;
        v_seq := v_seq + 1;
      elsif v_delta < 0 then
        v_uc := inv._sale_unit_cost(v_item, 'woo_order', v_ref, k);
        v_mid := inv._post_in(v_item, v_loc, 'sale_return',
          jsonb_build_array(jsonb_build_object('qty', -v_delta, 'unit_cost', coalesce(v_uc, (inv._resolve_in_cost(v_item, v_loc, null)).unit_cost))),
          case when v_uc is not null then 'sale_cogs' else 'on_hand_avg' end,
          'woo_order', v_ref, k || ':r' || v_seq, '#' || v_number, 'Order line reduced', v_by, now(),
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_net := v_net + v_delta;
        v_seq := v_seq + 1;
      end if;

      v_lines := v_lines || jsonb_build_object(k, e || jsonb_build_object(
        'ordered', v_want, 'net', v_net, 'seq', v_seq));
    end loop;

    v_action := case
      when s.stock_state = 'none' then 'deducted'
      when s.stock_state = 'restored' then 'deducted'
      when array_length(v_mids, 1) > 0 then 'adjusted'
      else 'ignored' end;
    s.stock_state := 'deducted';

  elsif v_restore and s.stock_state = 'deducted' then
    for k in select key from jsonb_object_keys(v_lines) key order by length(key), key loop
      e := v_lines->k;
      v_net := (e->>'net')::numeric;
      v_seq := (e->>'seq')::int;
      if v_net > 0 then
        v_item := (e->>'item_id')::uuid;
        v_uc := inv._sale_unit_cost(v_item, 'woo_order', v_ref, k);
        v_mid := inv._post_in(v_item, v_loc, 'sale_return',
          jsonb_build_array(jsonb_build_object('qty', v_net, 'unit_cost', coalesce(v_uc, (inv._resolve_in_cost(v_item, v_loc, null)).unit_cost))),
          case when v_uc is not null then 'sale_cogs' else 'on_hand_avg' end,
          'woo_order', v_ref, k || ':r' || v_seq, '#' || v_number, 'Order ' || v_status, v_by, now(),
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_lines := v_lines || jsonb_build_object(k, e || jsonb_build_object('net', 0, 'seq', v_seq + 1));
      end if;
    end loop;
    s.stock_state := 'restored';
    v_action := 'restored';
  end if;

  update inv.woo_order_sync set
    woo_status = v_status,
    stock_state = s.stock_state,
    location_id = v_loc,
    lines = coalesce((select jsonb_agg(value order by key) from jsonb_each(v_lines)), '[]'),
    unmatched = v_unmatched,
    last_payload = o,
    processed_at = now()
  where woo_order_id = v_order;

  return jsonb_build_object(
    'order_id', v_order, 'status', v_status, 'action', v_action, 'stock_state', s.stock_state,
    'location', inv._loc_code(v_loc),
    'unmatched_skus', v_unmatched,
    'movements', coalesce((select jsonb_agg(inv._movement_json(x) order by x) from unnest(v_mids) x), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- Refund → return (spec §7.3)
-- refund: Woo REST /orders/:id/refunds/:rid — line_items[].quantity is NEGATIVE,
-- and meta_data `_refunded_item_id` points at the original order line.
-- ---------------------------------------------------------------------------
create or replace function inv.apply_woo_refund(p_order_id bigint, r jsonb) returns jsonb
language plpgsql as $$
declare
  s        inv.woo_order_sync;
  v_rid    text := r->>'id';
  v_lines  jsonb;
  li       jsonb;
  v_orig   text;
  k        text;
  e        jsonb;
  v_qty    numeric;
  v_take   numeric;
  v_item   uuid;
  v_uc     numeric;
  v_mid    bigint;
  v_mids   bigint[] := '{}';
  v_by     text := 'system:woo-refund';
begin
  if v_rid is null then perform inv._raise('VALIDATION', 'refund id is required'); end if;
  select * into s from inv.woo_order_sync where woo_order_id = p_order_id for update;
  if s.woo_order_id is null or s.refunds ? v_rid then
    return jsonb_build_object('order_id', p_order_id, 'refund_id', v_rid, 'action', 'ignored', 'movements', '[]'::jsonb);
  end if;

  select coalesce(jsonb_object_agg(x->>'line_id', x), '{}') into v_lines from jsonb_array_elements(s.lines) x;

  for li in select * from jsonb_array_elements(coalesce(r->'line_items', '[]')) loop
    v_qty := abs(coalesce((li->>'quantity')::numeric, 0));
    if v_qty = 0 then continue; end if;
    select m->>'value' into v_orig from jsonb_array_elements(coalesce(li->'meta_data', '[]')) m
     where m->>'key' = '_refunded_item_id' limit 1;
    k := null;
    if v_orig is not null and v_lines ? v_orig then
      k := v_orig;
    else
      v_item := inv._woo_line_item(li);
      select key into k from jsonb_each(v_lines) where value->>'item_id' = v_item::text limit 1;
    end if;
    if k is null then continue; end if;

    e := v_lines->k;
    -- Only what was actually deducted (stock_state deducted) can be returned
    v_take := case when s.stock_state = 'deducted' then least(v_qty, (e->>'net')::numeric) else 0 end;
    if v_take > 0 then
      v_item := (e->>'item_id')::uuid;
      v_uc := inv._sale_unit_cost(v_item, 'woo_order', p_order_id::text, k);
      v_mid := inv._post_in(v_item, coalesce(s.location_id, inv._resolve_location(null)), 'sale_return',
        jsonb_build_array(jsonb_build_object('qty', v_take, 'unit_cost',
          coalesce(v_uc, (inv._resolve_in_cost(v_item, coalesce(s.location_id, inv._resolve_location(null)), null)).unit_cost))),
        case when v_uc is not null then 'sale_cogs' else 'on_hand_avg' end,
        'woo_refund', v_rid, coalesce(li->>'id', k), '#' || p_order_id, 'Refund ' || v_rid, v_by, now(),
        jsonb_build_object('woo_order_id', p_order_id, 'woo_line_id', k));
      v_mids := v_mids || v_mid;
    end if;
    -- refunded increases either way (even if the order was not deducted), so a later deduct skips refunded units
    v_lines := v_lines || jsonb_build_object(k, e || jsonb_build_object(
      'net', (e->>'net')::numeric - v_take,
      'refunded', (e->>'refunded')::numeric + v_qty));
  end loop;

  update inv.woo_order_sync set
    refunds = refunds || to_jsonb(v_rid),
    lines = coalesce((select jsonb_agg(value order by key) from jsonb_each(v_lines)), '[]'),
    processed_at = now()
  where woo_order_id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'refund_id', v_rid,
    'action', case when array_length(v_mids, 1) > 0 then 'applied' else 'ignored' end,
    'movements', coalesce((select jsonb_agg(inv._movement_json(x) order by x) from unnest(v_mids) x), '[]'));
end $$;

update inv.settings set value = '0.2.0', updated_at = now() where key = 'schema_version';

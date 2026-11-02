-- inventory-ledger v0.11.0
-- =============================================================================
-- 0099_inv_push_worker.sql — stock push that cannot get stuck (Bark incident 2026-10-26)
-- =============================================================================
-- What happened: Woo saves became slow (a plugin exporting each product on save). One push
-- batch took longer than the function limit, the run was killed before any item was marked,
-- the claims expired and the SAME batch was claimed and rewritten every 2–3 minutes. Variations
-- (handled after simple products) were never reached, the rest of the queue never moved, and
-- each rewrite put back stock that a POS sale had just taken in Woo.
--
-- The worker (api/lib/inventory/woo-push.js) now: works inside a time budget, writes in small
-- adaptive chunks and marks each chunk as soon as it returns, interleaves products and
-- variations by age, never retries a write that timed out, reads Woo first and skips items Woo
-- already holds, and releases what it did not get to. This migration adds the SQL it needs:
--   release_stock_push(ids)          give unprocessed claims back at once (no 2-minute wait)
--   defer_stock_push(ids, min, why)  postpone without counting as an error
--   stock_push_queue.deferred_since  when Woo was first seen lower than our last push
--   list_stock_push_due              also returns last_pushed_qty, deferred_since, requested_at
-- Setting push_foreign_change_grace_minutes (10): when Woo's stock has dropped since our last
-- push and is below the ledger (a sale in Woo/POS whose order has not reached the ledger yet),
-- the push waits this long before the ledger value is written anyway (the ledger is master).
-- =============================================================================

insert into inv.settings (key, value) values ('push_foreign_change_grace_minutes', '10')
on conflict (key) do nothing;

alter table inv.stock_push_queue add column if not exists deferred_since timestamptz;

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
         claimed_until = null, deferred_since = null
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
    returning q.item_id, q.requested_at, q.last_pushed_qty, q.last_pushed_at, q.deferred_since
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', s.item_id, 'sku', s.sku,
           'woo_product_id', s.woo_product_id, 'woo_variation_id', s.woo_variation_id,
           'available', s.available,
           'qty_to_push', case when v_floor then greatest(floor(s.available), 0) else floor(s.available) end,
           'requested_at', c.requested_at, 'last_pushed_qty', c.last_pushed_qty,
           'last_pushed_at', c.last_pushed_at, 'deferred_since', c.deferred_since)
           order by c.requested_at, s.sku), '[]'::jsonb)
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
           attempts = 0, last_error = null, next_attempt_at = null, claimed_until = null,
           deferred_since = null
     where item_id = p_item_id;
  else
    update inv.stock_push_queue
       set attempts = attempts + 1, last_result = 'error', last_error = left(p_error, 1000),
           next_attempt_at = now() + least(power(2, attempts + 1), 60) * interval '1 minute',
           claimed_until = null
     where item_id = p_item_id;
  end if;
end $$;

-- Give claims back at once (items the run did not get to inside its time budget).
create or replace function inv.release_stock_push(p_item_ids uuid[]) returns int
language sql as $$
  with u as (
    update inv.stock_push_queue set claimed_until = null
     where item_id = any(p_item_ids) returning 1
  ) select count(*)::int from u
$$;

-- Postpone without counting as an error. deferred_since is set the first time only.
create or replace function inv.defer_stock_push(p_item_ids uuid[], p_minutes int, p_reason text default null) returns int
language sql as $$
  with u as (
    update inv.stock_push_queue
       set next_attempt_at = now() + make_interval(mins => greatest(p_minutes, 1)),
           claimed_until = null, last_result = 'deferred', last_error = left(p_reason, 1000),
           deferred_since = coalesce(deferred_since, now())
     where item_id = any(p_item_ids) returning 1
  ) select count(*)::int from u
$$;

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
    'deferred_items', coalesce((select jsonb_agg(jsonb_build_object(
                       'sku', i.sku, 'reason', q.last_error, 'deferred_since', q.deferred_since,
                       'next_attempt_at', q.next_attempt_at) order by q.deferred_since)
                     from inv.stock_push_queue q join inv.item i on i.id = q.item_id
                     where q.last_result = 'deferred'
                       and (q.last_pushed_at is null or q.requested_at > q.last_pushed_at)), '[]'::jsonb),
    'claimed_now', (select count(*) from inv.stock_push_queue where claimed_until > now()),
    'skipped_items', (select count(*) from inv.stock_push_queue where last_result = 'skipped'))
$$;

revoke execute on function inv.release_stock_push(uuid[]), inv.defer_stock_push(uuid[], int, text) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema inv from %I', r);
      execute format('revoke all on all functions in schema inv from %I', r);
    end if;
  end loop;
end $$;

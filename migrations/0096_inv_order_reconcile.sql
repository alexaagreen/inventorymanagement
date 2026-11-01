-- inventory-ledger v0.9.0
-- =============================================================================
-- 0096_inv_order_reconcile.sql — nightly order reconcile with a run log in the DB
-- =============================================================================
-- Webhooks and the 30-minute backfill apply Woo order changes as they happen. The
-- order reconcile is the safety net on top: it pulls every order modified in a
-- window (default the last 7 days, widened back to the last successful run, capped
-- at 35 days), runs each through apply_woo_order again (idempotent — only real
-- differences are booked), then compares what Woo says with what the ledger holds.
--
-- Everything a run does is stored, so a UI can show it:
--   inv.order_reconcile_run    one row per run: window, status, counts, a log
--                              (array of {at, level, message}), the orders it changed
--                              and the issues it saw.
--   inv.order_reconcile_issue  one row per problem, de-duplicated across runs while
--                              open; auto-resolved when a later run finds it fixed;
--                              can be resolved or ignored by hand.
--
-- Issue kinds (reported, never corrected automatically):
--   unmatched_sku         Woo line with no matching ledger item → stock never deducted
--   line_mismatch         ledger net for a line ≠ what Woo's order implies
--   refund_missing_in_woo the ledger booked a refund that Woo no longer has (deleted)
--   order_missing_in_woo  the ledger deducted for an order Woo no longer has (deleted)
--   apply_failed          applying the order raised an error (message in details)
--
-- An order moved to the trash in Woo follows restore_statuses like any other status
-- change ('trash' is in the default list), so its stock is returned by the run.
--
-- Settings: order_reconcile_days (7), order_reconcile_max_days (35).
-- The HTTP worker (api/lib/inventory/woo-order.js reconcileOrders) calls:
--   start_order_reconcile → [check_woo_order per order, log_order_reconcile per page]
--   → finish_order_reconcile.
-- =============================================================================

insert into inv.settings (key, value) values
  ('order_reconcile_days',     '7'),
  ('order_reconcile_max_days', '35')
on conflict (key) do nothing;

create table if not exists inv.order_reconcile_run (
  id               uuid primary key default gen_random_uuid(),
  trigger          text not null default 'manual' check (trigger in ('cron', 'manual')),
  run_by           text,
  status           text not null default 'running' check (status in ('running', 'ok', 'issues', 'partial', 'failed')),
  window_from      timestamptz not null,
  window_to        timestamptz not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  orders_checked   int not null default 0,
  orders_changed   int not null default 0,
  movements        int not null default 0,
  missing_checked  int not null default 0,
  issues_new       int not null default 0,
  issues_seen      int not null default 0,
  issues_resolved  int not null default 0,
  issues_open      int not null default 0,     -- open issues overall when the run finished
  issue_ids        uuid[] not null default '{}',
  changes          jsonb not null default '[]', -- [{order_id, number, status, action, movements, refunds}]
  log              jsonb not null default '[]', -- [{at, level: info|warn|error, message}]
  error            text,
  check (window_from < window_to)
);
create index if not exists idx_order_reconcile_run_started on inv.order_reconcile_run (started_at desc, id desc);

create table if not exists inv.order_reconcile_issue (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('unmatched_sku', 'line_mismatch', 'refund_missing_in_woo',
                                               'order_missing_in_woo', 'apply_failed')),
  woo_order_id   bigint not null,
  order_number   text,
  ref            text not null default '',    -- line id / refund id; '' for order-level issues
  sku            text,
  woo_qty        numeric(14,3),               -- what Woo implies
  ledger_qty     numeric(14,3),               -- what the ledger holds
  message        text not null,
  details        jsonb not null default '{}',
  first_run_id   uuid references inv.order_reconcile_run(id) on delete set null,
  last_run_id    uuid references inv.order_reconcile_run(id) on delete set null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  seen_count     int not null default 1,
  resolved_at    timestamptz,
  resolved_by    text,
  resolution     text check (resolution in ('auto', 'manual', 'ignored')),
  note           text
);
-- One open issue per (kind, order, ref); resolved/ignored ones are history.
create unique index if not exists uq_order_reconcile_issue_open
  on inv.order_reconcile_issue (kind, woo_order_id, ref) where resolved_at is null;
create index if not exists idx_order_reconcile_issue_order on inv.order_reconcile_issue (woo_order_id);
create index if not exists idx_order_reconcile_issue_seen on inv.order_reconcile_issue (last_seen_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Run lifecycle
-- ---------------------------------------------------------------------------
create or replace function inv._order_reconcile_run_json(p_id uuid, p_full boolean default false) returns jsonb
language sql stable as $$
  select case when p_full then to_jsonb(r)
              else to_jsonb(r) - 'log' - 'changes' - 'issue_ids' end
         || jsonb_build_object('duration_ms', (extract(epoch from (coalesce(r.finished_at, now()) - r.started_at)) * 1000)::bigint)
    from inv.order_reconcile_run r where r.id = p_id
$$;

-- p: { trigger?: 'cron'|'manual', by? (→ run_by), days?, window_from?, window_to? } → run
create or replace function inv.start_order_reconcile(p jsonb default '{}') returns jsonb
language plpgsql as $$
declare
  v_max   int := coalesce(nullif(inv._setting('order_reconcile_max_days'), '')::int, 35);
  v_days  int := coalesce((p->>'days')::int, nullif(inv._setting('order_reconcile_days'), '')::int, 7);
  v_to    timestamptz := coalesce((p->>'window_to')::timestamptz, now());
  v_from  timestamptz := (p->>'window_from')::timestamptz;
  v_last  timestamptz;
  v_id    uuid;
begin
  if v_days < 1 or v_days > v_max then
    perform inv._raise('VALIDATION', format('days must be between 1 and %s', v_max), jsonb_build_object('field', 'days', 'max', v_max));
  end if;
  -- A run that never finished (serverless timeout, crash) is closed as failed.
  update inv.order_reconcile_run
     set status = 'failed', finished_at = now(), error = coalesce(error, 'did not finish (timed out or crashed)')
   where status = 'running' and started_at < now() - interval '30 minutes';
  perform pg_advisory_xact_lock(hashtext('inv.order_reconcile'));
  if exists (select 1 from inv.order_reconcile_run where status = 'running') then
    perform inv._raise('RECONCILE_RUNNING', 'an order reconcile is already running',
      (select jsonb_build_object('run_id', id, 'started_at', started_at) from inv.order_reconcile_run where status = 'running' limit 1));
  end if;
  if v_from is null then
    -- Last N days, widened back to the end of the last completed run (catches long outages).
    select max(window_to) into v_last from inv.order_reconcile_run where status in ('ok', 'issues');
    v_from := least(v_to - make_interval(days => v_days), coalesce(v_last, v_to));
    v_from := greatest(v_from, v_to - make_interval(days => v_max));
  end if;
  if v_from >= v_to then perform inv._raise('VALIDATION', 'window_from must be before window_to', '{"field":"window_from"}'); end if;
  if v_to - v_from > make_interval(days => v_max) then
    perform inv._raise('VALIDATION', format('window is longer than %s days', v_max), jsonb_build_object('field', 'window_from', 'max', v_max));
  end if;

  insert into inv.order_reconcile_run (trigger, run_by, window_from, window_to, log)
  values (coalesce(nullif(p->>'trigger', ''), 'manual'), nullif(p->>'by', ''), v_from, v_to,
          jsonb_build_array(jsonb_build_object('at', now(), 'level', 'info',
            'message', format('Checking orders modified %s – %s', to_char(v_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
                              to_char(v_to at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')))))
  returning id into v_id;
  return inv._order_reconcile_run_json(v_id);
end $$;

-- Append progress to a running run: p: { log?: [{level, message}], counts?: {orders_checked, …} }
create or replace function inv.log_order_reconcile(p_run uuid, p jsonb) returns void
language plpgsql as $$
declare c jsonb := coalesce(p->'counts', '{}');
begin
  update inv.order_reconcile_run set
    log = case when jsonb_array_length(log) >= 5000 then log
               else log || coalesce((select jsonb_agg(jsonb_build_object('at', coalesce(x->>'at', now()::text),
                                     'level', coalesce(x->>'level', 'info'), 'message', x->>'message'))
                                       from jsonb_array_elements(coalesce(p->'log', '[]')) x), '[]') end,
    orders_checked  = coalesce((c->>'orders_checked')::int, orders_checked),
    orders_changed  = coalesce((c->>'orders_changed')::int, orders_changed),
    movements       = coalesce((c->>'movements')::int, movements),
    missing_checked = coalesce((c->>'missing_checked')::int, missing_checked)
  where id = p_run and status = 'running';
end $$;

-- Ledger orders that deducted stock, were last seen modified inside the window, and
-- were not returned by Woo's order list in this run → candidates for "deleted in Woo".
create or replace function inv.order_reconcile_missing_candidates(p jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(s.woo_order_id order by s.woo_order_id), '[]')
    from (select s.woo_order_id from inv.woo_order_sync s
           where s.stock_state = 'deducted'
             and coalesce(inv._woo_ts(s.last_payload->>'date_modified_gmt'), inv._woo_ts(s.last_payload->>'date_modified'), s.processed_at)
                 >= (p->>'window_from')::timestamptz
             and coalesce(inv._woo_ts(s.last_payload->>'date_modified_gmt'), inv._woo_ts(s.last_payload->>'date_modified'), s.processed_at)
                 <  (p->>'window_to')::timestamptz
             and not (s.woo_order_id = any (coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(p->'seen') x), '{}')))
           order by s.woo_order_id
           limit coalesce((p->>'limit')::int, 500)) s
$$;

-- ---------------------------------------------------------------------------
-- Compare one Woo order (REST/webhook payload, already applied) with the ledger.
-- Returns [{kind, woo_order_id, order_number, ref, sku, woo_qty, ledger_qty, message, details}].
-- ---------------------------------------------------------------------------
create or replace function inv.check_woo_order(o jsonb) returns jsonb
language plpgsql stable as $$
declare
  v_id    bigint := (o->>'id')::bigint;
  v_num   text := coalesce(o->>'number', o->>'id');
  s       inv.woo_order_sync;
  v_out   jsonb := '[]';
  v_wq    jsonb;
  v_rids  jsonb;
  e       jsonb;
  v_woo   numeric;
  v_exp   numeric;
  v_rid   text;
  v_moves jsonb;
begin
  select * into s from inv.woo_order_sync where woo_order_id = v_id;
  if s.woo_order_id is null then return v_out; end if;

  select coalesce(jsonb_object_agg(li->>'id', coalesce((li->>'quantity')::numeric, 0)), '{}') into v_wq
    from jsonb_array_elements(coalesce(o->'line_items', '[]')) li where li->>'id' is not null;

  -- Woo lines the ledger could not match: stock was never deducted for them.
  if s.stock_state = 'deducted' then
    for e in select * from jsonb_array_elements(s.unmatched) loop
      v_out := v_out || jsonb_build_object('kind', 'unmatched_sku', 'woo_order_id', v_id, 'order_number', v_num,
        'ref', coalesce(e->>'line_id', ''), 'sku', nullif(e->>'sku', ''),
        'woo_qty', (e->>'quantity')::numeric, 'ledger_qty', 0,
        'message', case when coalesce(e->>'sku', '') = ''
                        then format('Line "%s" has no SKU — stock was not deducted', coalesce(e->>'name', e->>'line_id'))
                        else format('SKU %s is not in the ledger — stock was not deducted', e->>'sku') end,
        'details', e);
    end loop;
  end if;

  -- Every ledger line must have converged: net = max(ordered − refunded, 0) while deducted, else 0.
  for e in select * from jsonb_array_elements(s.lines) loop
    v_woo := coalesce((v_wq->>(e->>'line_id'))::numeric, 0);
    v_exp := case when s.stock_state = 'deducted' then greatest(v_woo - coalesce((e->>'refunded')::numeric, 0), 0) else 0 end;
    if coalesce((e->>'net')::numeric, 0) <> v_exp then
      v_out := v_out || jsonb_build_object('kind', 'line_mismatch', 'woo_order_id', v_id, 'order_number', v_num,
        'ref', e->>'line_id', 'sku', e->>'sku', 'woo_qty', v_exp, 'ledger_qty', (e->>'net')::numeric,
        'message', format('%s: Woo implies %s deducted, the ledger has %s', e->>'sku', v_exp, (e->>'net')::numeric),
        'details', jsonb_build_object('woo_status', o->>'status', 'stock_state', s.stock_state, 'woo_ordered', v_woo,
                                      'ledger_ordered', (e->>'ordered')::numeric, 'refunded', (e->>'refunded')::numeric));
    end if;
  end loop;

  -- Refunds the ledger booked that Woo no longer lists (deleted refunds).
  if o ? 'refunds' then
    select coalesce(jsonb_agg(r->>'id'), '[]') into v_rids from jsonb_array_elements(coalesce(o->'refunds', '[]')) r;
    for v_rid in select jsonb_array_elements_text(s.refunds) loop
      if not (v_rids ? v_rid) then
        select coalesce(jsonb_agg(jsonb_build_object('sku', inv._sku(m.item_id), 'qty', m.qty, 'movement_id', m.id) order by m.id), '[]')
          into v_moves from inv.movement m where m.ref_type = 'woo_refund' and m.ref_id = v_rid;
        v_out := v_out || jsonb_build_object('kind', 'refund_missing_in_woo', 'woo_order_id', v_id, 'order_number', v_num,
          'ref', v_rid, 'sku', null, 'woo_qty', 0,
          'ledger_qty', (select coalesce(sum((x->>'qty')::numeric), 0) from jsonb_array_elements(v_moves) x),
          'message', format('Refund %s was booked in the ledger but no longer exists in Woo', v_rid),
          'details', jsonb_build_object('movements', v_moves));
      end if;
    end loop;
  end if;
  return v_out;
end $$;

-- Issue for an order the ledger deducted that Woo no longer has (404 on GET /orders/:id).
create or replace function inv.order_missing_issue(p_order_id bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object('kind', 'order_missing_in_woo', 'woo_order_id', s.woo_order_id,
    'order_number', coalesce(s.last_payload->>'number', s.woo_order_id::text), 'ref', '', 'sku', null,
    'woo_qty', 0, 'ledger_qty', (select coalesce(sum((x->>'net')::numeric), 0) from jsonb_array_elements(s.lines) x),
    'message', 'Order was deleted in Woo but its stock is still deducted in the ledger',
    'details', jsonb_build_object('woo_status_last_seen', s.woo_status, 'stock_state', s.stock_state,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('sku', x->>'sku', 'net', (x->>'net')::numeric)), '[]')
                  from jsonb_array_elements(s.lines) x where (x->>'net')::numeric <> 0)))
    from inv.woo_order_sync s where s.woo_order_id = p_order_id
$$;

-- p: { run_id, complete: bool, error?, checked: [order ids], issues: [...], changes: [...],
--      log: [...], counts: {orders_checked, orders_changed, movements, missing_checked} } → run (full)
create or replace function inv.finish_order_reconcile(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_run      uuid := inv._to_uuid(p->>'run_id');
  r          inv.order_reconcile_run;
  i          jsonb;
  v_issue    uuid;
  v_ins      boolean;
  v_ids      uuid[] := '{}';
  v_new      int := 0;
  v_resolved int := 0;
  v_checked  bigint[] := coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(coalesce(p->'checked', '[]')) x), '{}');
  v_status   text;
  c          jsonb := coalesce(p->'counts', '{}');
begin
  select * into r from inv.order_reconcile_run where id = v_run for update;
  if r.id is null then perform inv._raise('NOT_FOUND', 'reconcile run not found', jsonb_build_object('run_id', p->>'run_id')); end if;
  if r.status <> 'running' then perform inv._raise('IMMUTABLE', 'reconcile run is already finished', jsonb_build_object('run_id', r.id, 'status', r.status)); end if;

  for i in select * from jsonb_array_elements(coalesce(p->'issues', '[]')) loop
    -- An issue someone chose to ignore stays ignored.
    if exists (select 1 from inv.order_reconcile_issue x
                where x.kind = i->>'kind' and x.woo_order_id = (i->>'woo_order_id')::bigint
                  and x.ref = coalesce(i->>'ref', '') and x.resolution = 'ignored') then
      continue;
    end if;
    insert into inv.order_reconcile_issue as x (kind, woo_order_id, order_number, ref, sku, woo_qty, ledger_qty,
                                                message, details, first_run_id, last_run_id)
    values (i->>'kind', (i->>'woo_order_id')::bigint, i->>'order_number', coalesce(i->>'ref', ''), nullif(i->>'sku', ''),
            (i->>'woo_qty')::numeric, (i->>'ledger_qty')::numeric, coalesce(i->>'message', i->>'kind'),
            coalesce(i->'details', '{}'), v_run, v_run)
    on conflict (kind, woo_order_id, ref) where resolved_at is null do update set
      order_number = excluded.order_number, sku = excluded.sku, woo_qty = excluded.woo_qty, ledger_qty = excluded.ledger_qty,
      message = excluded.message, details = excluded.details, last_run_id = v_run, last_seen_at = now(),
      seen_count = x.seen_count + case when x.last_run_id = v_run then 0 else 1 end
    returning x.id, (x.xmax = 0) into v_issue, v_ins;
    if not (v_issue = any (v_ids)) then
      v_ids := v_ids || v_issue;
      if v_ins then v_new := v_new + 1; end if;
    end if;
  end loop;

  -- Open issues for orders this run checked that it did not report again are fixed.
  with fixed as (
    update inv.order_reconcile_issue x
       set resolved_at = now(), resolved_by = 'system:order-reconcile', resolution = 'auto', last_run_id = v_run
     where x.resolved_at is null and x.woo_order_id = any (v_checked) and not (x.id = any (v_ids))
    returning 1)
  select count(*) into v_resolved from fixed;

  v_status := case when nullif(p->>'error', '') is not null then 'failed'
                   when not coalesce((p->>'complete')::boolean, false) then 'partial'
                   when cardinality(v_ids) > 0 then 'issues'
                   else 'ok' end;

  update inv.order_reconcile_run set
    status          = v_status,
    finished_at     = now(),
    error           = nullif(p->>'error', ''),
    orders_checked  = coalesce((c->>'orders_checked')::int, orders_checked),
    orders_changed  = coalesce((c->>'orders_changed')::int, orders_changed),
    movements       = coalesce((c->>'movements')::int, movements),
    missing_checked = coalesce((c->>'missing_checked')::int, missing_checked),
    issue_ids       = v_ids,
    issues_new      = v_new,
    issues_seen     = cardinality(v_ids),
    issues_resolved = v_resolved,
    issues_open     = (select count(*)::int from inv.order_reconcile_issue where resolved_at is null),
    changes         = (select coalesce(jsonb_agg(z.x order by z.n), '[]') from (
                         select x, n from jsonb_array_elements(changes || coalesce(p->'changes', '[]')) with ordinality t(x, n)
                          order by n limit 2000) z),
    log             = log || coalesce((select jsonb_agg(jsonb_build_object('at', coalesce(x->>'at', now()::text),
                                         'level', coalesce(x->>'level', 'info'), 'message', x->>'message'))
                                         from jsonb_array_elements(coalesce(p->'log', '[]')) x), '[]')
                          || jsonb_build_array(jsonb_build_object('at', now(),
                               'level', case v_status when 'failed' then 'error' when 'ok' then 'info' else 'warn' end,
                               'message', format('Finished: %s — %s orders checked, %s changed, %s issue(s) (%s new), %s auto-resolved',
                                 v_status, coalesce((c->>'orders_checked')::int, r.orders_checked),
                                 coalesce((c->>'orders_changed')::int, r.orders_changed),
                                 cardinality(v_ids), v_new, v_resolved)))
  where id = v_run;
  return inv._order_reconcile_run_json(v_run, true);
end $$;

-- p: { id, action: 'resolve'|'ignore'|'reopen', note?, by? } → issue
create or replace function inv.resolve_order_reconcile_issue(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id     uuid := inv._to_uuid(p->>'id');
  v_action text := coalesce(nullif(p->>'action', ''), 'resolve');
  x        inv.order_reconcile_issue;
begin
  select * into x from inv.order_reconcile_issue where id = v_id for update;
  if x.id is null then perform inv._raise('NOT_FOUND', 'issue not found', jsonb_build_object('id', p->>'id')); end if;
  if v_action not in ('resolve', 'ignore', 'reopen') then
    perform inv._raise('VALIDATION', 'action must be resolve, ignore or reopen', '{"field":"action"}');
  end if;
  if v_action = 'reopen' then
    if x.resolved_at is null then return to_jsonb(x); end if;
    if exists (select 1 from inv.order_reconcile_issue y where y.kind = x.kind and y.woo_order_id = x.woo_order_id
                and y.ref = x.ref and y.resolved_at is null) then
      perform inv._raise('IMMUTABLE', 'a newer open issue exists for this order line', jsonb_build_object('id', x.id));
    end if;
    update inv.order_reconcile_issue set resolved_at = null, resolved_by = null, resolution = null,
           note = coalesce(nullif(p->>'note', ''), note)
     where id = v_id returning * into x;
  else
    update inv.order_reconcile_issue set resolved_at = coalesce(resolved_at, now()),
           resolved_by = coalesce(nullif(p->>'by', ''), 'unknown'),
           resolution = case v_action when 'ignore' then 'ignored' else 'manual' end,
           note = coalesce(nullif(p->>'note', ''), note)
     where id = v_id returning * into x;
  end if;
  return to_jsonb(x);
end $$;

revoke all on inv.order_reconcile_run, inv.order_reconcile_issue from public;
revoke execute on function inv.start_order_reconcile(jsonb), inv.log_order_reconcile(uuid, jsonb),
  inv.order_reconcile_missing_candidates(jsonb), inv.check_woo_order(jsonb), inv.order_missing_issue(bigint),
  inv.finish_order_reconcile(jsonb), inv.resolve_order_reconcile_issue(jsonb),
  inv._order_reconcile_run_json(uuid, boolean) from public;
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

update inv.settings set value = '0.9.0', updated_at = now() where key = 'schema_version';

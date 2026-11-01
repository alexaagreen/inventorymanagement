-- inventory-ledger v0.11.0
-- =============================================================================
-- 0098_inv_month_close.sql — end-of-month report: quantity and value per SKU at month close
-- =============================================================================
-- Stock as of any point in time is rebuilt from the ledger itself:
--   qty   = Σ movement.qty with occurred_at < at
--   value = Σ over FIFO layers whose creating movement occurred before `at` of
--           (qty_in − consumption by movements that occurred before `at`) × layer unit_cost
-- This is the same rule as stock_balance.value (uncovered consumption carries no value),
-- so stock as of now() equals stock_balance exactly (tested in t32).
--
-- A month close freezes that picture at the end of a month (local time, setting
-- `timezone`, default Europe/Oslo) in two tables:
--   inv.month_close       one row per month: cutoff, totals, who/when, recalc history
--   inv.month_close_line  one row per item × location with qty and value (sku, name and
--                         location code are copied so the report reads as it was)
--
-- A closed month never changes by itself. If a movement is posted later with an
-- occurred_at inside a closed month (backdated adjustment, late order import), the close
-- reports it as `backdated_movements` > 0 (movements with id above the close's
-- movement_watermark and occurred_at before its cutoff) and can be recalculated on purpose
-- (close_month {recalculate:true}); the previous totals are kept in `history`.
--
-- Backtracking: close_due_months closes every completed month from the first month with
-- movements up to the last completed month that is not closed yet — the first run builds
-- the whole history, later runs (monthly cron) only add the new month.
-- Settings: timezone (Europe/Oslo), month_close_grace_hours (2): a month is only closed
-- automatically when its cutoff is at least this long ago (late webhooks/backfill).
-- =============================================================================

insert into inv.settings (key, value) values
  ('timezone',                'Europe/Oslo'),
  ('month_close_grace_hours', '2')
on conflict (key) do nothing;

create table if not exists inv.month_close (
  id                  uuid primary key default gen_random_uuid(),
  period              date not null unique check (period = date_trunc('month', period)::date),
  cutoff_at           timestamptz not null,
  timezone            text not null,
  total_qty           numeric(16,3) not null default 0,
  total_value         numeric(16,2) not null default 0,
  sku_count           int not null default 0,
  line_count          int not null default 0,
  negative_lines      int not null default 0,
  movement_watermark  bigint not null default 0,   -- max(movement.id) when the lines were computed
  source              text not null check (source in ('scheduled', 'manual', 'backfill')),
  closed_by           text,
  closed_at           timestamptz not null default now(),
  recalculated_at     timestamptz,
  recalculated_by     text,
  recalc_count        int not null default 0,
  history             jsonb not null default '[]',
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
drop trigger if exists trg_month_close_updated on inv.month_close;
create trigger trg_month_close_updated before update on inv.month_close
  for each row execute function inv.set_updated_at();

create table if not exists inv.month_close_line (
  close_id       uuid not null references inv.month_close(id) on delete cascade,
  item_id        uuid not null references inv.item(id),
  location_id    uuid not null references inv.location(id),
  sku            text not null,
  item_name      text,
  location_code  text not null,
  qty            numeric(14,3) not null,
  value          numeric(14,2) not null,
  primary key (close_id, item_id, location_id)
);
create index if not exists idx_month_close_line_item on inv.month_close_line (item_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function inv._tz() returns text
language sql stable as $$
  select coalesce(nullif(inv._setting('timezone'), ''), 'Europe/Oslo')
$$;

-- 'YYYY-MM' or any date in the month → first day of the month
create or replace function inv._period(p text) returns date
language plpgsql immutable as $$
begin
  if p is null or btrim(p) = '' then
    perform inv._raise('VALIDATION', 'period is required (YYYY-MM)', '{"field":"period"}');
  end if;
  if btrim(p) ~ '^\d{4}-\d{2}$' then
    return to_date(btrim(p) || '-01', 'YYYY-MM-DD');
  end if;
  return date_trunc('month', btrim(p)::date)::date;
exception
  when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
    perform inv._raise('VALIDATION', 'period must be YYYY-MM', jsonb_build_object('field', 'period', 'value', p));
end $$;

-- End of the month in local time = start of the next month (exclusive)
create or replace function inv._period_cutoff(p_period date) returns timestamptz
language sql stable as $$
  select ((p_period + interval '1 month')::timestamp) at time zone inv._tz()
$$;

-- Stock per item × location as of `p_at` (exclusive), rebuilt from movements and layers.
create or replace function inv._stock_as_of(p_at timestamptz)
returns table (item_id uuid, location_id uuid, qty numeric, value numeric)
language sql stable as $$
  with q as (
    select m.item_id, m.location_id, sum(m.qty) as qty
      from inv.movement m
     where m.occurred_at < p_at
     group by 1, 2
  ), used as (
    select lc.layer_id, sum(lc.qty) as qty
      from inv.layer_consumption lc
      join inv.movement mo on mo.id = lc.movement_id
     where lc.layer_id is not null and mo.occurred_at < p_at
     group by 1
  ), v as (
    select cl.item_id, cl.location_id,
           sum((cl.qty_in - coalesce(u.qty, 0)) * cl.unit_cost) as value
      from inv.cost_layer cl
      join inv.movement mi on mi.id = cl.movement_id and mi.occurred_at < p_at
      left join used u on u.layer_id = cl.id
     group by 1, 2
  )
  select coalesce(q.item_id, v.item_id), coalesce(q.location_id, v.location_id),
         coalesce(q.qty, 0), coalesce(round(v.value, 2), 0)
    from q full join v on v.item_id = q.item_id and v.location_id = q.location_id
   where coalesce(q.qty, 0) <> 0 or coalesce(round(v.value, 2), 0) <> 0
$$;

create or replace function inv._month_close_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(c) || jsonb_build_object(
           'period', to_char(c.period, 'YYYY-MM'),
           'backdated_movements', (select count(*) from inv.movement m
                                    where m.id > c.movement_watermark and m.occurred_at < c.cutoff_at))
    from inv.month_close c where c.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Close one month. Existing close is returned unchanged unless p_recalc.
-- ---------------------------------------------------------------------------
create or replace function inv._close_month(p_period date, p_by text, p_source text,
  p_recalc boolean default false, p_note text default null, out close_id uuid, out action text)
language plpgsql as $$
declare
  v_cutoff timestamptz := inv._period_cutoff(p_period);
  v_id     uuid;
  v_action text;
  c        inv.month_close;
begin
  if v_cutoff > now() then
    perform inv._raise('VALIDATION', format('%s is not over yet — it can be closed from %s',
      to_char(p_period, 'YYYY-MM'), to_char(v_cutoff at time zone inv._tz(), 'YYYY-MM-DD HH24:MI')),
      jsonb_build_object('period', to_char(p_period, 'YYYY-MM'), 'cutoff_at', v_cutoff));
  end if;
  -- One close per period at a time
  perform pg_advisory_xact_lock(hashtext('inv.month_close'), (p_period - date '2000-01-01'));

  select * into c from inv.month_close mc where mc.period = p_period for update;
  if c.id is not null and not coalesce(p_recalc, false) then
    close_id := c.id; action := 'existing'; return;
  end if;

  if c.id is null then
    insert into inv.month_close (period, cutoff_at, timezone, source, closed_by, note)
    values (p_period, v_cutoff, inv._tz(), p_source, p_by, p_note)
    returning id into v_id;
    v_action := 'closed';
  else
    v_id := c.id; v_action := 'recalculated';
    delete from inv.month_close_line l where l.close_id = v_id;
  end if;

  insert into inv.month_close_line (close_id, item_id, location_id, sku, item_name, location_code, qty, value)
  select v_id, s.item_id, s.location_id, i.sku, i.name, loc.code, s.qty, s.value
    from inv._stock_as_of(v_cutoff) s
    join inv.item i on i.id = s.item_id
    join inv.location loc on loc.id = s.location_id;

  update inv.month_close mc
     set total_qty = t.qty, total_value = t.value, sku_count = t.skus,
         line_count = t.lines, negative_lines = t.neg,
         movement_watermark = coalesce((select max(id) from inv.movement), 0),
         cutoff_at = v_cutoff, timezone = inv._tz(),
         recalculated_at = case when v_action = 'recalculated' then now() end,
         recalculated_by = case when v_action = 'recalculated' then p_by end,
         recalc_count = mc.recalc_count + case when v_action = 'recalculated' then 1 else 0 end,
         note = coalesce(p_note, mc.note),
         history = case when v_action = 'recalculated'
           then mc.history || jsonb_build_array(jsonb_build_object(
                  'replaced_at', now(), 'replaced_by', p_by,
                  'total_qty', mc.total_qty, 'total_value', mc.total_value,
                  'sku_count', mc.sku_count, 'line_count', mc.line_count,
                  'computed_at', coalesce(mc.recalculated_at, mc.closed_at)))
           else mc.history end
    from (select coalesce(sum(l.qty), 0) as qty, coalesce(sum(l.value), 0) as value,
                 count(distinct l.item_id) as skus, count(*) as lines,
                 count(*) filter (where l.qty < 0) as neg
            from inv.month_close_line l where l.close_id = v_id) t
   where mc.id = v_id;

  close_id := v_id; action := v_action;
end $$;

-- close_month { period: 'YYYY-MM', by?, recalculate?: bool, note?, source?: manual|scheduled|backfill }
create or replace function inv.close_month(p jsonb) returns jsonb
language plpgsql as $$
declare
  r record;
  v_source text := coalesce(nullif(p->>'source', ''), 'manual');
begin
  if v_source not in ('scheduled', 'manual', 'backfill') then
    perform inv._raise('VALIDATION', 'source must be manual, scheduled or backfill');
  end if;
  select * into r from inv._close_month(inv._period(p->>'period'), nullif(p->>'by', ''), v_source,
    coalesce((p->>'recalculate')::boolean, false), nullif(p->>'note', ''));
  -- Own statement: _month_close_json is STABLE and must see the rows above.
  return inv._month_close_json(r.close_id) || jsonb_build_object('action', r.action);
end $$;

-- close_due_months { by?, source?: scheduled|backfill|manual, from?: 'YYYY-MM', through?: 'YYYY-MM',
--                    ignore_grace?: bool }
-- Closes every completed month in [from, through] that has no close yet. from defaults to the
-- month of the first movement, through to the last completed month (cutoff + grace ≤ now).
create or replace function inv.close_due_months(p jsonb default '{}') returns jsonb
language plpgsql as $$
declare
  v_source  text := coalesce(nullif(p->>'source', ''), 'scheduled');
  v_by      text := nullif(p->>'by', '');
  v_grace   interval := case when coalesce((p->>'ignore_grace')::boolean, false) then interval '0'
                          else make_interval(hours => coalesce(nullif(inv._setting('month_close_grace_hours'), '')::int, 2)) end;
  v_first   date;
  v_from    date;
  v_through date;
  v_last    date;
  v_m       date;
  r         record;
  v_closed  jsonb := '[]';
  v_existing int := 0;
begin
  if v_source not in ('scheduled', 'manual', 'backfill') then
    perform inv._raise('VALIDATION', 'source must be manual, scheduled or backfill');
  end if;
  select date_trunc('month', min(occurred_at) at time zone inv._tz())::date into v_first from inv.movement;
  -- Last month whose cutoff (+ grace) has passed
  v_last := (date_trunc('month', (now() - v_grace) at time zone inv._tz()) - interval '1 month')::date;
  v_through := v_last;
  if nullif(p->>'through', '') is not null then
    v_through := least(inv._period(p->>'through'), v_last);
  end if;
  v_from := v_first;
  if nullif(p->>'from', '') is not null then
    v_from := greatest(inv._period(p->>'from'), coalesce(v_first, inv._period(p->>'from')));
  end if;

  if v_first is null or v_from is null then
    return jsonb_build_object('closed', '[]'::jsonb, 'existing', 0, 'from', null,
                              'through', to_char(v_through, 'YYYY-MM'), 'message', 'no movements in the ledger');
  end if;

  v_m := v_from;
  while v_m <= v_through loop
    select * into r from inv._close_month(v_m, v_by, v_source, false, null);
    if r.action = 'closed' then
      v_closed := v_closed || to_jsonb(to_char(v_m, 'YYYY-MM'));
    else
      v_existing := v_existing + 1;
    end if;
    v_m := (v_m + interval '1 month')::date;
  end loop;

  return jsonb_build_object('closed', v_closed, 'existing', v_existing,
    'from', to_char(v_from, 'YYYY-MM'), 'through', to_char(v_through, 'YYYY-MM'));
end $$;

-- ---------------------------------------------------------------------------
-- Grants: server-only like the rest of inv (0006)
-- ---------------------------------------------------------------------------
revoke all on inv.month_close, inv.month_close_line from public;
revoke execute on function inv._tz(), inv._period(text), inv._period_cutoff(date),
  inv._stock_as_of(timestamptz), inv._month_close_json(uuid),
  inv._close_month(date, text, text, boolean, text), inv.close_month(jsonb),
  inv.close_due_months(jsonb) from public;
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

update inv.settings set value = '0.11.0', updated_at = now() where key = 'schema_version';

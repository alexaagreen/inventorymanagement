-- T32: month close (v0.11.0) — stock as of a date, month snapshots, backfill, backdating, recalculation
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');
select t.item('MC-A'); select t.item('MC-B'); select t.item('MC-C');

-- January 2026 (Europe/Oslo)
select t.receive('MC-A', 10, 100, '2026-01-15 10:00+01');
select inv.record_sale('{"ref_id":"MC-S1","occurred_at":"2026-01-20 12:00+01","lines":[{"sku":"MC-A","qty":3}]}');
-- MC-B is sold before it is received: negative, uncovered (estimated cost, no value)
select inv.record_sale('{"ref_id":"MC-S2","occurred_at":"2026-01-25 12:00+01","lines":[{"sku":"MC-B","qty":2}]}');
-- 23:30 on 31 Jan local = 22:30Z → still January
select inv.record_sale('{"ref_id":"MC-S3","occurred_at":"2026-01-31 23:30+01","lines":[{"sku":"MC-A","qty":1}]}');

-- February 2026
-- 00:30 on 1 Feb local = 23:30Z on 31 Jan → February
select inv.record_sale('{"ref_id":"MC-S4","occurred_at":"2026-02-01 00:30+01","lines":[{"sku":"MC-A","qty":1}]}');
select t.receive('MC-B', 5, 50, '2026-02-05 10:00+01');     -- covers the 2 sold in January
select t.receive('MC-A', 5, 120, '2026-02-10 10:00+01');
select inv.record_sale('{"ref_id":"MC-S5","occurred_at":"2026-02-20 12:00+01","lines":[{"sku":"MC-A","qty":6}]}');  -- 5@100 + 1@120
select inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","occurred_at":"2026-02-25 12:00+01","lines":[{"sku":"MC-A","qty":2}]}');

-- March 2026: revaluation + a reversal (reversals happen "now")
select inv.create_adjustment('{"reason":"reval","location":"MAIN","occurred_at":"2026-03-10 12:00+01","lines":[{"sku":"MC-B","revalue_to_unit_cost":60}]}');
select t.receive('MC-C', 4, 10, '2026-03-12 10:00+01');

do $$
declare
  v jsonb; c jsonb; n int; v_total numeric;
begin
  -- 1) Stock as of now() is exactly stock_balance (qty and value) for every item × location
  select count(*) into n
    from inv.stock_balance b
    full join inv._stock_as_of(now() + interval '1 second') s
      on s.item_id = b.item_id and s.location_id = b.location_id
   where coalesce(b.on_hand, 0) is distinct from coalesce(s.qty, 0)
      or coalesce(b.value, 0) is distinct from coalesce(s.value, 0);
  perform t.eq(n, 0, 'as-of now() = stock_balance');

  -- 2) January close
  c := inv.close_month('{"period":"2026-01","by":"test"}');
  perform t.eq(c->>'action', 'closed', 'jan closed');
  perform t.eq(c->>'period', '2026-01', 'period text');
  perform t.eq((c->>'cutoff_at')::timestamptz, '2026-02-01 00:00+01'::timestamptz, 'cutoff is local midnight');
  perform t.eq((select qty from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A'), 6.000, 'jan A qty (10-3-1)');
  perform t.eq((select value from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A'), 600.00, 'jan A value');
  perform t.eq((select qty from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-B'), -2.000, 'jan B negative');
  perform t.eq((select value from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-B'), 0.00, 'jan B: uncovered has no value');
  perform t.ok(not exists (select 1 from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-C'), 'jan: C not yet received');
  perform t.eq((c->>'total_value')::numeric, 600.00, 'jan total value');
  perform t.eq((c->>'negative_lines')::int, 1, 'jan negative lines');
  perform t.eq((c->>'backdated_movements')::int, 0, 'jan nothing backdated');

  -- Same call again: idempotent
  v := inv.close_month('{"period":"2026-01","by":"test"}');
  perform t.eq(v->>'action', 'existing', 'second close returns existing');
  perform t.eq(v->>'id', c->>'id', 'same close');

  -- 3) February close: per location
  c := inv.close_month('{"period":"2026-02-14","by":"test"}');   -- any date in the month works
  perform t.eq(c->>'period', '2026-02', 'feb period');
  perform t.eq((select qty from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A' and location_code = 'MAIN'), 2.000, 'feb A MAIN');
  perform t.eq((select value from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A' and location_code = 'MAIN'), 240.00, 'feb A MAIN value');
  perform t.eq((select qty from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A' and location_code = 'BUTIKK'), 2.000, 'feb A BUTIKK');
  perform t.eq((select value from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-A' and location_code = 'BUTIKK'), 240.00, 'feb A BUTIKK value');
  perform t.eq((select qty from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-B'), 3.000, 'feb B covered');
  perform t.eq((select value from inv.month_close_line where close_id = (c->>'id')::uuid and sku = 'MC-B'), 150.00, 'feb B value');
  perform t.eq((c->>'sku_count')::int, 2, 'feb sku count (A over two locations counts once)');
  perform t.eq((c->>'line_count')::int, 3, 'feb lines');

  -- 4) close_due_months fills every missing completed month from the first movement on
  v := inv.close_due_months('{"by":"cron","ignore_grace":true}');
  perform t.eq(v->>'from', '2026-01', 'backfill starts at first movement month');
  perform t.ok(v->'closed' ? '2026-03', 'march closed by backfill');
  perform t.ok(not (v->'closed' ? '2026-01'), 'january already closed');
  perform t.eq((v->>'existing')::int, 2, 'jan + feb existing');
  perform t.eq((select source from inv.month_close where period = '2026-03-01'), 'scheduled', 'source');
  perform t.eq((select total_value from inv.month_close where period = '2026-03-01'),
               240.00 + 240.00 + 180.00 + 40.00, 'march: A 2@120 MAIN + 2@120 BUTIKK, B revalued 3@60, C 4@10');
  v := inv.close_due_months('{"by":"cron","ignore_grace":true}');
  perform t.eq(jsonb_array_length(v->'closed'), 0, 'second run closes nothing');
  -- every month between first movement and last completed month has exactly one close
  perform t.eq((select count(*)::int from inv.month_close),
               (select count(*)::int from generate_series(date '2026-01-01',
                  (date_trunc('month', now() at time zone 'Europe/Oslo') - interval '1 month')::date, interval '1 month')),
               'one close per completed month');

  -- 5) A closed month is frozen; a backdated movement is flagged, recalculation picks it up
  perform inv.create_adjustment('{"reason":"telling","location":"MAIN","occurred_at":"2026-01-28 12:00+01","lines":[{"sku":"MC-C","delta":1,"unit_cost":7}]}');
  c := inv._month_close_json((select id from inv.month_close where period = '2026-01-01'));
  perform t.eq((c->>'backdated_movements')::int, 1, 'backdated movement flagged');
  perform t.eq((c->>'total_value')::numeric, 600.00, 'jan still frozen');
  c := inv.close_month('{"period":"2026-01","by":"alex","recalculate":true}');
  perform t.eq(c->>'action', 'recalculated', 'recalculated');
  perform t.eq((c->>'total_value')::numeric, 607.00, 'jan now includes the backdated adjustment');
  perform t.eq((c->>'backdated_movements')::int, 0, 'flag cleared after recalculation');
  perform t.eq((c->>'recalc_count')::int, 1, 'recalc count');
  perform t.eq(c->>'recalculated_by', 'alex', 'recalculated_by');
  perform t.eq(jsonb_array_length(c->'history'), 1, 'history kept');
  perform t.eq((c->'history'->0->>'total_value')::numeric, 600.00, 'previous total in history');

  -- 6) Reversal posted now does not change the past
  perform inv.reverse_movement((select id from inv.movement where ref_id = 'MC-S5'), 'test', 'oops');
  perform t.eq((select sum(value) from inv._stock_as_of('2026-03-01 00:00+01') where item_id = (select id from inv.item where sku = 'MC-A')),
               480.00, 'reversal today leaves february as it was');
  select count(*) into n from inv.stock_balance b
    full join inv._stock_as_of(now() + interval '1 second') s on s.item_id = b.item_id and s.location_id = b.location_id
   where coalesce(b.on_hand, 0) is distinct from coalesce(s.qty, 0) or coalesce(b.value, 0) is distinct from coalesce(s.value, 0);
  perform t.eq(n, 0, 'as-of now() = stock_balance after reversal');

  -- 7) Validation
  perform t.expect_error($q$select inv.close_month(jsonb_build_object('period', to_char(now(), 'YYYY-MM')))$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.close_month('{"period":"2026-13"}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.close_month('{}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.close_month('{"period":"2026-01","source":"x"}')$q$, 'VALIDATION');
  perform t.integrity();
end $$;

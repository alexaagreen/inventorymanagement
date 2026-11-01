-- v0.9.0: order reconcile — run log in the DB, issue de-dup / auto-resolve / ignore
select t.item('KNIV-1', 101);
select t.item('KNIV-2', 102);
select t.receive('KNIV-1', 10, 100);
select t.receive('KNIV-2', 10, 50);
do $$
declare
  run jsonb; run2 jsonb; fin jsonb; iss jsonb; o jsonb; v_issue uuid; c jsonb;
begin
  -- Window: default 7 days back, widened to the end of the last completed run, capped at max_days
  run := inv.start_order_reconcile('{"trigger":"cron","by":"test"}');
  perform t.eq(run->>'status', 'running', 'run starts as running');
  perform t.ok((run->>'window_to')::timestamptz - (run->>'window_from')::timestamptz between interval '6 days 23 hours' and interval '7 days 1 hour', '7-day window');
  perform t.expect_error($q$select inv.start_order_reconcile('{}')$q$, 'RECONCILE_RUNNING');
  perform t.expect_error($q$select inv.start_order_reconcile('{"days":99}')$q$, 'VALIDATION');
  perform inv.log_order_reconcile((run->>'id')::uuid, '{"log":[{"message":"page 1: 2 orders"}],"counts":{"orders_checked":2}}');
  perform t.eq((select orders_checked from inv.order_reconcile_run where id = (run->>'id')::uuid), 2, 'progress counts stored');
  perform t.eq((select jsonb_array_length(log) from inv.order_reconcile_run where id = (run->>'id')::uuid), 2, 'log appended');

  -- Order 1: clean. Order 2: one line has an unknown SKU. Order 3: refund booked, later deleted in Woo.
  perform inv.apply_woo_order('{"id":1,"number":"1001","status":"processing","line_items":[{"id":11,"product_id":101,"quantity":2}]}');
  o := '{"id":2,"number":"1002","status":"processing","line_items":[{"id":21,"product_id":102,"quantity":1},{"id":22,"sku":"GHOST","name":"Ghost knife","product_id":999,"quantity":3}],"refunds":[]}';
  perform inv.apply_woo_order(o);
  perform inv.apply_woo_order('{"id":3,"number":"1003","status":"completed","line_items":[{"id":31,"product_id":101,"quantity":2}]}');
  perform inv.apply_woo_refund(3, '{"id":700,"line_items":[{"id":7001,"product_id":101,"quantity":-1,"meta_data":[{"key":"_refunded_item_id","value":"31"}]}]}');

  perform t.eq(jsonb_array_length(inv.check_woo_order('{"id":1,"status":"processing","line_items":[{"id":11,"product_id":101,"quantity":2}],"refunds":[]}')), 0, 'clean order has no issues');
  iss := inv.check_woo_order(o);
  perform t.eq(jsonb_array_length(iss), 1, 'one issue on order 2');
  perform t.eq(iss->0->>'kind', 'unmatched_sku', 'unmatched sku reported');
  perform t.eq(iss->0->>'sku', 'GHOST', 'sku on issue');
  perform t.eq((iss->0->>'woo_qty')::numeric, 3::numeric, 'woo qty on issue');
  iss := iss || inv.check_woo_order('{"id":3,"number":"1003","status":"completed","line_items":[{"id":31,"product_id":101,"quantity":2}],"refunds":[]}');
  perform t.eq(iss->1->>'kind', 'refund_missing_in_woo', 'deleted refund reported');
  perform t.eq(iss->1->>'ref', '700', 'refund id as ref');
  perform t.eq((iss->1->>'ledger_qty')::numeric, 1.000, 'refund qty from its movements');

  -- line_mismatch: tamper with the snapshot (simulates a state the machine never converged on)
  update inv.woo_order_sync set lines = jsonb_set(lines, '{0,net}', '5') where woo_order_id = 1;
  c := inv.check_woo_order('{"id":1,"status":"processing","line_items":[{"id":11,"product_id":101,"quantity":2}]}');
  perform t.eq(c->0->>'kind', 'line_mismatch', 'line mismatch detected');
  perform t.eq((c->0->>'woo_qty')::numeric, 2::numeric, 'expected 2');
  perform t.eq((c->0->>'ledger_qty')::numeric, 5::numeric, 'ledger 5');
  update inv.woo_order_sync set lines = jsonb_set(lines, '{0,net}', '2') where woo_order_id = 1;

  -- Missing-in-Woo candidates: deducted, modified inside the window, not seen this run
  update inv.woo_order_sync set last_payload = last_payload || jsonb_build_object('date_modified_gmt', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS'));
  perform t.eq(inv.order_reconcile_missing_candidates(jsonb_build_object('window_from', run->>'window_from', 'window_to', run->>'window_to', 'seen', '[2,3]'::jsonb)),
               '[1]'::jsonb, 'order 1 not seen → candidate');
  iss := iss || inv.order_missing_issue(1);
  perform t.eq(iss->2->>'kind', 'order_missing_in_woo', 'missing order issue');
  perform t.eq((iss->2->>'ledger_qty')::numeric, 2::numeric, 'still deducted qty');

  fin := inv.finish_order_reconcile(jsonb_build_object('run_id', run->>'id', 'complete', true, 'checked', '[1,2,3]'::jsonb,
           'issues', iss, 'changes', '[{"order_id":2,"number":"1002","action":"adjusted","movements":1}]'::jsonb,
           'log', '[{"level":"warn","message":"order 2: unmatched GHOST"}]'::jsonb,
           'counts', '{"orders_checked":3,"orders_changed":1,"movements":1,"missing_checked":1}'::jsonb));
  perform t.eq(fin->>'status', 'issues', 'run with issues');
  perform t.eq((fin->>'issues_new')::int, 3, '3 new issues');
  perform t.eq((fin->>'issues_open')::int, 3, '3 open');
  perform t.eq(jsonb_array_length(fin->'changes'), 1, 'changes stored');
  perform t.ok((fin->'log'->-1->>'message') like 'Finished: issues%', 'final log line');
  perform t.expect_error(format($q$select inv.finish_order_reconcile('{"run_id":"%s","complete":true}')$q$, run->>'id'), 'IMMUTABLE');

  -- Run 2: order 2 still broken (de-duplicated), order 3's refund is back (auto-resolved),
  -- order 1 was checked and is fine now (auto-resolved). Window widens to the last run's end.
  run2 := inv.start_order_reconcile('{"days":1}');
  perform t.ok((run2->>'window_from')::timestamptz <= (run->>'window_to')::timestamptz, 'window starts at last completed run');
  fin := inv.finish_order_reconcile(jsonb_build_object('run_id', run2->>'id', 'complete', true, 'checked', '[1,2,3]'::jsonb,
           'issues', jsonb_build_array(iss->0)));
  perform t.eq((fin->>'issues_new')::int, 0, 'no new issues');
  perform t.eq((fin->>'issues_resolved')::int, 2, 'two auto-resolved');
  perform t.eq((select seen_count from inv.order_reconcile_issue where kind = 'unmatched_sku'), 2, 'seen twice');
  perform t.eq((select count(*)::int from inv.order_reconcile_issue where resolution = 'auto'), 2, 'auto resolution');

  -- Ignore: never reported again
  v_issue := (select id from inv.order_reconcile_issue where kind = 'unmatched_sku');
  perform inv.resolve_order_reconcile_issue(jsonb_build_object('id', v_issue, 'action', 'ignore', 'by', 'alex', 'note', 'test SKU'));
  run2 := inv.start_order_reconcile('{}');
  fin := inv.finish_order_reconcile(jsonb_build_object('run_id', run2->>'id', 'complete', true, 'checked', '[2]'::jsonb,
           'issues', jsonb_build_array(iss->0)));
  perform t.eq(fin->>'status', 'ok', 'ignored issue does not count');
  perform t.eq((select count(*)::int from inv.order_reconcile_issue where kind = 'unmatched_sku'), 1, 'not re-created');

  -- Manual resolve → reported again by a later run as a new open issue; reopen guarded
  perform inv.resolve_order_reconcile_issue(jsonb_build_object('id', v_issue, 'action', 'reopen'));
  perform t.ok((select resolved_at is null from inv.order_reconcile_issue where id = v_issue), 'reopened');
  perform inv.resolve_order_reconcile_issue(jsonb_build_object('id', v_issue, 'action', 'resolve', 'by', 'alex'));
  run2 := inv.start_order_reconcile('{}');
  fin := inv.finish_order_reconcile(jsonb_build_object('run_id', run2->>'id', 'complete', false, 'checked', '[2]'::jsonb,
           'issues', jsonb_build_array(iss->0)));
  perform t.eq(fin->>'status', 'partial', 'incomplete run is partial');
  perform t.eq((fin->>'issues_new')::int, 1, 'manually resolved issue comes back as new');
  perform t.expect_error(format($q$select inv.resolve_order_reconcile_issue('{"id":"%s","action":"reopen"}')$q$, v_issue), 'IMMUTABLE');
  perform t.expect_error($q$select inv.resolve_order_reconcile_issue('{"id":"nope"}')$q$, 'NOT_FOUND');

  -- Failed run + stale running runs are closed by the next start
  run2 := inv.start_order_reconcile('{}');
  fin := inv.finish_order_reconcile(jsonb_build_object('run_id', run2->>'id', 'error', 'Woo GET /orders → 500'));
  perform t.eq(fin->>'status', 'failed', 'error → failed');
  run2 := inv.start_order_reconcile('{}');
  update inv.order_reconcile_run set started_at = now() - interval '2 hours' where id = (run2->>'id')::uuid;
  run2 := inv.start_order_reconcile('{}');
  perform t.eq((select count(*)::int from inv.order_reconcile_run where status = 'running'), 1, 'stale run closed');
  perform t.ok((select error from inv.order_reconcile_run where status = 'failed' order by started_at limit 1) is not null, 'stale run has error');
  -- A partial/failed run does not count as completed: the window still reaches back to the last ok/issues run
  perform t.integrity();
end $$;

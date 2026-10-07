-- T19 (DB-del): bevegelser køer push; list/claim/mark; uendret → ingenting; variasjon gir parent-id
select t.item('KNIV-1', 101); select t.item('KNIV-2', 102, 9001); select t.item('LOCAL-ONLY');
do $$
declare d jsonb; s jsonb;
begin
  perform t.receive('KNIV-1', 5, 100);
  perform t.receive('KNIV-2', 3, 50);
  perform t.receive('LOCAL-ONLY', 1, 10);
  d := inv.list_stock_push_due(100);
  perform t.eq(jsonb_array_length(d), 2, 'two pushable items');
  perform t.eq((d->0->>'qty_to_push')::numeric, 5::numeric, 'knv1 qty');
  perform t.eq((d->1->>'woo_variation_id')::bigint, 9001::bigint, 'variation id');
  perform t.eq((d->1->>'woo_product_id')::bigint, 102::bigint, 'parent id');
  -- claim: ny list gir ingenting mens claimed
  perform t.eq(jsonb_array_length(inv.list_stock_push_due(100)), 0, 'claimed');
  perform inv.mark_stock_pushed((d->0->>'item_id')::uuid, 5, true);
  perform inv.mark_stock_pushed((d->1->>'item_id')::uuid, 3, false, 'HTTP 500');
  s := inv.stock_push_status();
  perform t.eq(jsonb_array_length(s->'failed_items'), 1, 'one failed');
  perform t.eq((s->>'skipped_items')::int, 1, 'local-only skipped');
  -- feilet vare har backoff → ikke due nå
  perform t.eq(jsonb_array_length(inv.list_stock_push_due(100)), 0, 'backoff');
  -- ny bevegelse på knv1 → due igjen
  perform inv.record_sale('{"ref_id":"S","lines":[{"sku":"KNIV-1","qty":1}]}');
  d := inv.list_stock_push_due(100);
  perform t.eq(jsonb_array_length(d), 1, 'knv1 due again');
  perform t.eq((d->0->>'qty_to_push')::numeric, 4::numeric, 'qty 4');
  perform inv.mark_stock_pushed((d->0->>'item_id')::uuid, 4, true);
  -- negativ beholdning pushes som 0
  perform inv.record_sale('{"ref_id":"S2","lines":[{"sku":"KNIV-1","qty":6}]}');
  d := inv.list_stock_push_due(100);
  perform t.eq((d->0->>'qty_to_push')::numeric, 0::numeric, 'floor zero');
  perform inv.mark_stock_pushed((d->0->>'item_id')::uuid, 0, true);
  -- enqueue alt
  perform t.eq((inv.enqueue_stock_push()->>'enqueued')::int, 2, 'enqueue all tracked');
end $$;

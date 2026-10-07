-- T8: Samme order.created-payload to ganger → én bevegelse per linje
select t.item('KNIV-1', 101); select t.item('KNIV-2', 102, 9001);
select t.receive('KNIV-1', 10, 100); select t.receive('KNIV-2', 10, 50);
do $$
declare o jsonb; r jsonb;
begin
  o := '{"id":48213,"number":"48213","status":"processing","date_created_gmt":"2026-10-07T08:00:00",
         "line_items":[{"id":771,"product_id":101,"variation_id":0,"sku":"KNIV-1","quantity":1},
                       {"id":772,"product_id":102,"variation_id":9001,"sku":"wrong-sku","quantity":2},
                       {"id":773,"product_id":999,"variation_id":0,"sku":"UNKNOWN","quantity":1}]}';
  r := inv.apply_woo_order(o, 'webhook');
  perform t.eq(r->>'action', 'deducted', 'deducted');
  perform t.eq(jsonb_array_length(r->'movements'), 2, 'two movements');
  perform t.eq(jsonb_array_length(r->'unmatched_skus'), 1, 'one unmatched');
  perform t.eq(r->'unmatched_skus'->0->>'sku', 'UNKNOWN', 'unmatched sku');
  perform t.eq(r->'movements'->0->>'ref_line', '771', 'ref_line = line id');
  perform t.eq(r->'movements'->0->>'reference', '#48213', 'reference');
  perform t.eq((r->'movements'->0->>'occurred_at')::timestamptz, '2026-10-07T08:00:00Z'::timestamptz, 'occurred_at = order date');
  perform t.eq(t.on_hand('KNIV-2'), 8.000, 'variation matched by ids');

  r := inv.apply_woo_order(o, 'webhook');
  perform t.eq(r->>'action', 'ignored', 'second time ignored');
  perform t.eq(jsonb_array_length(r->'movements'), 0, 'no new movements');
  perform t.eq((select count(*) from inv.movement where type = 'sale')::int, 2, 'still two sales');
  perform t.eq(t.on_hand('KNIV-1'), 9.000, 'on_hand 9');
  perform t.eq((select stock_state from inv.woo_order_sync where woo_order_id = 48213), 'deducted', 'state');

  -- pending trekker ikke
  r := inv.apply_woo_order('{"id":5,"status":"pending","line_items":[{"id":1,"product_id":101,"quantity":1}]}', 'webhook');
  perform t.eq(r->>'action', 'ignored', 'pending ignored');
  perform t.eq(t.on_hand('KNIV-1'), 9.000, 'unchanged by pending');
  -- ... men gjør det når den blir processing
  r := inv.apply_woo_order('{"id":5,"status":"processing","line_items":[{"id":1,"product_id":101,"quantity":1}]}', 'webhook');
  perform t.eq(r->>'action', 'deducted', 'pending → processing');
  perform t.eq(t.on_hand('KNIV-1'), 8.000, 'on_hand 8');
  perform t.integrity();
end $$;

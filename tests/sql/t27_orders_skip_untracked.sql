-- v0.6.0: orders_skip_untracked
select inv.upsert_item('{"sku":"SKI-T","woo_product_id":501,"track_stock":true}');
select inv.upsert_item('{"sku":"RENT-T","woo_product_id":502,"track_stock":false}');
do $$
declare r jsonb;
begin
  -- default (false): untracked items still get a sale (v0.5 behaviour, T22)
  r := inv.apply_woo_order('{"id":7001,"status":"processing","line_items":[{"id":1,"product_id":501,"quantity":1},{"id":2,"product_id":502,"quantity":1}]}', 'webhook');
  perform t.eq(jsonb_array_length(r->'movements'), 2, 'default: both lines become sales');
  perform t.eq(jsonb_array_length(r->'ignored_untracked'), 0, 'default: nothing ignored');

  update inv.settings set value = 'true' where key = 'orders_skip_untracked';
  r := inv.apply_woo_order('{"id":7002,"status":"processing","line_items":[{"id":1,"product_id":501,"quantity":2},{"id":2,"product_id":502,"quantity":1}]}', 'webhook');
  perform t.eq(jsonb_array_length(r->'movements'), 1, 'skip: only the tracked line is a sale');
  perform t.eq(r->'ignored_untracked'->0->>'sku', 'RENT-T', 'skip: untracked listed as ignored');
  perform t.eq(jsonb_array_length(r->'unmatched_skus'), 0, 'skip: not reported as unmatched');
  perform t.eq((select count(*)::int from inv.movement m join inv.item i on i.id = m.item_id where i.sku = 'RENT-T' and m.ref_id = '7002'), 0, 'no movement for untracked');

  -- cancel restores only what was deducted
  r := inv.apply_woo_order('{"id":7002,"status":"cancelled","line_items":[{"id":1,"product_id":501,"quantity":2},{"id":2,"product_id":502,"quantity":1}]}', 'webhook');
  perform t.eq(jsonb_array_length(r->'movements'), 1, 'cancel returns the tracked line only');
  perform t.eq((r->'movements'->0->>'qty')::numeric, 2.000, 'returned qty');
  update inv.settings set value = 'false' where key = 'orders_skip_untracked';
  perform t.integrity();
end $$;

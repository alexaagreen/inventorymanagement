-- T22: Vare med track_stock=false → bevegelser tillatt, aldri push, skipped i status
select inv.upsert_item('{"sku":"BUNDLE-1","woo_product_id":300,"track_stock":false}');
do $$
declare r jsonb;
begin
  r := inv.post_movement('{"sku":"BUNDLE-1","type":"opening_balance","qty":2,"unit_cost":10}');
  perform t.eq((r->>'qty')::numeric, 2.000, 'movement allowed');
  perform t.eq(jsonb_array_length(inv.list_stock_push_due(100)), 0, 'never pushed');
  perform t.eq((select last_result from inv.stock_push_queue q join inv.item i on i.id = q.item_id where i.sku = 'BUNDLE-1'), 'skipped', 'skipped');
  -- slås track_stock på → køes
  perform inv.upsert_item('{"sku":"BUNDLE-1","woo_product_id":300,"track_stock":true}');
  perform t.eq(jsonb_array_length(inv.list_stock_push_due(100)), 1, 'due after enabling');
end $$;

-- upsert_items bulk + deactivate_missing + SKU-bytte følger Woo-id
do $$
declare r jsonb;
begin
  perform inv.upsert_item('{"sku":"OLD","woo_product_id":400}');
  r := inv.upsert_items('{"deactivate_missing":true,"items":[
         {"sku":"NEW","woo_product_id":400,"name":"Renamed"},
         {"sku":"BUNDLE-1","woo_product_id":300},
         {"woo_product_id":500,"name":"no sku"}]}');
  perform t.eq((r->>'upserted')::int, 2, 'two upserted');
  perform t.eq(jsonb_array_length(r->'skipped'), 1, 'one skipped');
  perform t.eq((select count(*) from inv.item where sku = 'OLD')::int, 0, 'sku renamed');
  perform t.eq((select name from inv.item where woo_product_id = 400), 'Renamed', 'name updated');
  perform t.eq((r->>'deactivated')::int, 0, 'nothing to deactivate');
  r := inv.upsert_items('{"deactivate_missing":true,"items":[{"sku":"NEW","woo_product_id":400}]}');
  perform t.eq((r->>'deactivated')::int, 1, 'BUNDLE-1 deactivated');
end $$;

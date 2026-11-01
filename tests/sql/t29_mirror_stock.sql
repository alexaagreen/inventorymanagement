-- v0.8.0: apply_mirror_stock writes pushed stock into the storefront mirror
drop table if exists public.product_variations, public.products;
do $$
begin
  perform t.eq(inv.apply_mirror_stock('{"products":[{"id":1,"stock_quantity":3}]}')->>'products', '0', 'no mirror → 0');
end $$;
create table public.products (id bigint primary key, stock_quantity int, stock_status text, source_payload jsonb not null default '{}');
create table public.product_variations (id bigint primary key, stock_quantity int);  -- older mirror: no status/payload
insert into public.products values (1, 0, 'out_of_stock', '{"name":"A"}'), (2, 5, 'in_stock', '{}');
insert into public.product_variations values (11, 0);
do $$
declare r jsonb;
begin
  r := inv.apply_mirror_stock('{"products":[{"id":1,"stock_quantity":7,"stock_status":"instock","manage_stock":true},{"id":2,"stock_quantity":0,"stock_status":"onbackorder"},{"id":999,"stock_quantity":1}],
                                "variations":[{"id":11,"stock_quantity":4,"stock_status":"instock"}]}');
  perform t.eq((r->>'products')::int, 2, 'two products updated (unknown id ignored)');
  perform t.eq((r->>'variations')::int, 1, 'variation updated without status/payload columns');
  perform t.eq((select stock_status from public.products where id = 1), 'in_stock', 'status mapped');
  perform t.eq((select stock_status from public.products where id = 2), 'on_backorder', 'backorder mapped');
  perform t.eq((select source_payload->>'name' from public.products where id = 1), 'A', 'payload kept');
  perform t.eq((select (source_payload->>'manage_stock')::boolean from public.products where id = 1), true, 'manage_stock in payload');
  perform t.eq((select stock_quantity from public.product_variations where id = 11), 4, 'variation qty');
  -- status missing in response → existing status kept
  perform inv.apply_mirror_stock('{"products":[{"id":1,"stock_quantity":6}]}');
  perform t.eq((select stock_status from public.products where id = 1), 'in_stock', 'status kept when not sent');
  update inv.settings set value = 'false' where key = 'mirror_stock_update';
  r := inv.apply_mirror_stock('{"products":[{"id":1,"stock_quantity":1}]}');
  perform t.ok(r ? 'skipped', 'off → skipped');
  perform t.eq((select stock_quantity from public.products where id = 1), 6, 'untouched when off');
end $$;
drop table public.product_variations, public.products;

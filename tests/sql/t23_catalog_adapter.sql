-- M7: katalog-adapter mot nettbutikkens speil (public.products / public.product_variations)
drop table if exists public.product_variations, public.products;
do $$ begin perform t.expect_error('select inv.upsert_items_from_catalog()', 'VALIDATION'); end $$;

create table public.products (
  id bigint primary key, slug text, name text not null, sku text, type text not null, status text not null,
  stock_quantity int, source_payload jsonb not null default '{}'
);
create table public.product_variations (
  id bigint primary key, parent_id bigint not null references public.products(id), sku text,
  stock_quantity int, attributes jsonb not null default '{}', source_payload jsonb not null default '{}'
);
insert into public.products (id, slug, name, sku, type, status, source_payload) values
  (1, 'halsband', 'Halsbånd', 'HB-1', 'simple', 'published', '{"manage_stock": true}'),
  (2, 'sele', 'Sele', 'SELE', 'variable', 'published', '{"manage_stock": false}'),
  (3, 'sett', 'Turpakke', 'SETT-1', 'simple', 'published', '{"manage_stock": false}'),
  (4, 'kladd', 'Kladd', 'DRAFT-1', 'simple', 'draft', '{"manage_stock": true}'),
  (5, 'uten-sku', 'Uten SKU', null, 'simple', 'published', '{"manage_stock": true}');
insert into public.product_variations (id, parent_id, sku, attributes, source_payload) values
  (21, 2, 'SELE-S', '{"storrelse": "S", "farge": "Svart"}', '{"manage_stock": true, "status": "publish"}'),
  (22, 2, 'SELE-M', '{"storrelse": "M"}', '{"manage_stock": "parent", "status": "publish"}');

do $$
declare r jsonb;
begin
  r := inv.upsert_items_from_catalog();
  perform t.eq((r->>'upserted')::int, 5, 'five items (simple x3 + variations x2)');
  perform t.eq(jsonb_array_length(r->'skipped'), 1, 'missing sku skipped');
  perform t.eq(r->>'source', 'storefront_mirror', 'source');
  perform t.eq((select track_stock from inv.item where sku = 'HB-1'), true, 'manage_stock true');
  perform t.eq((select track_stock from inv.item where sku = 'SETT-1'), false, 'bundle not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'SELE-M'), false, 'parent-managed variation not tracked');
  perform t.eq((select active from inv.item where sku = 'DRAFT-1'), false, 'draft inactive');
  perform t.eq((select name from inv.item where sku = 'SELE-S'), 'Sele – Svart / S', 'variation name');
  perform t.eq((select woo_product_id from inv.item where sku = 'SELE-S'), 2::bigint, 'parent id');
  perform t.eq((select woo_variation_id from inv.item where sku = 'SELE-S'), 21::bigint, 'variation id');
  perform t.eq((select count(*) from inv.item where sku = 'SELE')::int, 0, 'variable parent is not an item');

  -- vare forsvinner fra speilet → deaktiveres; SKU-bytte følger Woo-id
  delete from public.products where id = 3;
  update public.products set sku = 'HB-1-NEW' where id = 1;
  r := inv.upsert_items_from_catalog();
  perform t.eq((r->>'deactivated')::int, 1, 'removed product deactivated');
  perform t.eq((select sku from inv.item where woo_product_id = 1 and woo_variation_id is null), 'HB-1-NEW', 'sku renamed');
end $$;
drop table public.product_variations, public.products;

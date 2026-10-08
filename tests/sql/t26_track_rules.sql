-- v0.6.0: track_stock_mode, excluded category roots, bundles
drop table if exists public.product_variations, public.products, public.categories;
create table public.categories (id bigint primary key, slug text not null, parent_id bigint references public.categories(id));
create table public.products (
  id bigint primary key, slug text, name text not null, sku text, type text not null, status text not null,
  stock_quantity int, categories bigint[] not null default '{}', bundle_components jsonb,
  source_payload jsonb not null default '{}'
);
create table public.product_variations (
  id bigint primary key, parent_id bigint not null references public.products(id), sku text,
  stock_quantity int, attributes jsonb not null default '{}', source_payload jsonb not null default '{}'
);
insert into public.categories values (1, 'majesty', null), (2, 'ski', 1), (3, 'utleie', null), (4, 'utleie-ski', 3), (5, 'thornfit', null);
insert into public.products (id, name, sku, type, status, categories, bundle_components, source_payload) values
  (10, 'Ski',          'SKI-1',  'simple',   'publish', '{2}',   null, '{"manage_stock": false}'),
  (11, 'Rental ski',   'RENT-1', 'simple',   'publish', '{4}',   null, '{"manage_stock": true}'),
  (12, 'Both',         'BOTH-1', 'simple',   'publish', '{2,4}', null, '{"manage_stock": false}'),
  (13, 'Bundle',       'BUN-1',  'simple',   'publish', '{2}',   '[{"sku":"SKI-1","qty":1}]', '{"manage_stock": true}'),
  (14, 'No category',  'NOCAT',  'simple',   'publish', '{}',    null, '{"manage_stock": false}'),
  (15, 'Rental boots', 'RB',     'variable', 'publish', '{4}',   null, '{}'),
  (16, 'Gym band',     'GB',     'variable', 'publish', '{5}',   null, '{}');
insert into public.product_variations (id, parent_id, sku, attributes, source_payload) values
  (151, 15, 'RB-42', '{"size": "42"}', '{"manage_stock": true}'),
  (161, 16, 'GB-L',  '{"size": "L"}',  '{"manage_stock": false}');

do $$
declare r jsonb;
begin
  -- default mode = v0.5 behaviour (Woo manage_stock), no exclusions; bundles never tracked
  r := inv.upsert_items_from_catalog();
  perform t.eq(r->>'track_stock_mode', 'woo_manage_stock', 'default mode');
  perform t.eq((select track_stock from inv.item where sku = 'RENT-1'), true, 'woo mode: manage_stock true tracked');
  perform t.eq((select track_stock from inv.item where sku = 'SKI-1'), false, 'woo mode: manage_stock false not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'BUN-1'), false, 'bundle never tracked');

  -- Handelsgutane: track everything except rental
  update inv.settings set value = 'all' where key = 'track_stock_mode';
  update inv.settings set value = 'utleie' where key = 'track_exclude_category_slugs';
  r := inv.upsert_items_from_catalog();
  perform t.eq((select track_stock from inv.item where sku = 'SKI-1'), true, 'all: tracked');
  perform t.eq((select track_stock from inv.item where sku = 'RENT-1'), false, 'under excluded root only: not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'BOTH-1'), true, 'under one non-excluded root: tracked');
  perform t.eq((select track_stock from inv.item where sku = 'BUN-1'), false, 'bundle still not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'NOCAT'), true, 'no category: tracked');
  perform t.eq((select track_stock from inv.item where sku = 'RB-42'), false, 'variation inherits excluded parent');
  perform t.eq((select track_stock from inv.item where sku = 'GB-L'), true, 'variation under thornfit tracked');

  update inv.settings set value = 'bogus' where key = 'track_stock_mode';
  perform t.expect_error('select inv.upsert_items_from_catalog()', 'VALIDATION');
  update inv.settings set value = 'woo_manage_stock' where key = 'track_stock_mode';
  update inv.settings set value = '' where key = 'track_exclude_category_slugs';
end $$;

-- mirror without categories / bundle columns still works (Bark-style older mirror)
drop table public.product_variations, public.products, public.categories;
create table public.products (id bigint primary key, name text not null, sku text, type text not null, status text not null, source_payload jsonb not null default '{}');
create table public.product_variations (id bigint primary key, parent_id bigint not null references public.products(id), sku text, attributes jsonb not null default '{}', source_payload jsonb not null default '{}');
insert into public.products values (20, 'Plain', 'PLAIN-1', 'simple', 'publish', '{"manage_stock": false}');
do $$
begin
  update inv.settings set value = 'all' where key = 'track_stock_mode';
  perform inv.upsert_items_from_catalog();
  perform t.eq((select track_stock from inv.item where sku = 'PLAIN-1'), true, 'all mode without category columns');
end $$;
drop table public.product_variations, public.products;

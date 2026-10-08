-- v0.6.0: track_stock_mode, excluded root categories, bundles, schema version.
-- A product under several roots is tracked when at least one root is not excluded.
-- Bundles (Woo type bundle, or the parent of a bundle_components row) are never tracked.

select t.eq((select value from inv.settings where key = 'schema_version'), '0.6.0', 'schema 0.6.0');
select t.eq((select value from inv.settings where key = 'track_stock_mode'), 'woo_manage_stock', 'default mode');
select t.eq((select value from inv.settings where key = 'track_exclude_category_slugs'), '', 'default exclude empty');

drop table if exists public.product_categories, public.bundle_components, public.product_variations, public.products, public.categories;

create table public.categories (
  id bigint primary key,
  slug text not null,
  parent_id bigint
);
create table public.products (
  id bigint primary key, slug text, name text not null, sku text, type text not null, status text not null,
  source_payload jsonb not null default '{}'
);
create table public.product_variations (
  id bigint primary key, parent_id bigint not null references public.products(id), sku text,
  attributes jsonb not null default '{}', source_payload jsonb not null default '{}'
);
create table public.product_categories (
  product_id bigint not null references public.products(id),
  category_id bigint not null references public.categories(id)
);
create table public.bundle_components (
  bundle_product_id bigint,
  component_product_id bigint
);

insert into public.categories (id, slug, parent_id) values
  (1, 'utleie', 0),
  (2, 'kniver', 0),
  (3, 'utleie-barn', 1);

insert into public.products (id, slug, name, sku, type, status, source_payload) values
  (10, 'on', 'On', 'T-ON', 'simple', 'published', '{"manage_stock": true}'),
  (11, 'off', 'Off', 'T-OFF', 'simple', 'published', '{"manage_stock": false}'),
  (12, 'rent', 'Rent', 'T-RENT', 'simple', 'published', '{"manage_stock": true}'),
  (13, 'mix', 'Mix', 'T-MIX', 'simple', 'published', '{"manage_stock": false}'),
  (14, 'mix-on', 'Mix on', 'T-MIX-ON', 'simple', 'published', '{"manage_stock": true}'),
  (15, 'child', 'Child', 'T-CHILD', 'simple', 'published', '{"manage_stock": true}'),
  (16, 'bundle', 'Bundle', 'T-BND', 'bundle', 'published', '{"manage_stock": true}'),
  (17, 'bparent', 'Parent', 'T-BPARENT', 'simple', 'published', '{"manage_stock": true}'),
  (18, 'comp', 'Component', 'T-COMP', 'simple', 'published', '{"manage_stock": true}'),
  (19, 'var', 'Variable', 'T-VAR', 'variable', 'published', '{"manage_stock": false}'),
  (20, 'grouped', 'Grouped', 'T-GROUP', 'grouped', 'published', '{"manage_stock": true}');
insert into public.product_variations (id, parent_id, sku, attributes, source_payload) values
  (191, 19, 'T-VAR-ON', '{"size": "S"}', '{"manage_stock": true, "status": "publish"}'),
  (192, 19, 'T-VAR-P', '{"size": "M"}', '{"manage_stock": "parent", "status": "publish"}');
insert into public.product_categories (product_id, category_id) values
  (12, 1),
  (13, 1), (13, 2),
  (14, 1), (14, 2),
  (15, 3);
insert into public.bundle_components (bundle_product_id, component_product_id) values (17, 18);

update inv.settings set value = ' utleie , unused ' where key = 'track_exclude_category_slugs';

do $$
declare r jsonb;
begin
  r := inv.upsert_items_from_catalog();
  perform t.eq(r->>'track_stock_mode', 'woo_manage_stock', 'mode reported');
  perform t.eq((select track_stock from inv.item where sku = 'T-ON'), true, 'manage_stock true tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-OFF'), false, 'manage_stock false not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-RENT'), false, 'excluded root not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-MIX'), false, 'mixed roots still follow manage_stock');
  perform t.eq((select track_stock from inv.item where sku = 'T-MIX-ON'), true, 'kept root is tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-CHILD'), false, 'child of excluded root not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-BND'), false, 'bundle type not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-BPARENT'), false, 'bundle parent not tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-COMP'), true, 'component tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-VAR-ON'), true, 'variation manage_stock true');
  perform t.eq((select track_stock from inv.item where sku = 'T-VAR-P'), false, 'parent-managed variation not tracked');
  perform t.eq((select count(*) from inv.item where sku = 'T-VAR')::int, 0, 'variable parent skipped');
  perform t.eq((select count(*) from inv.item where sku = 'T-GROUP')::int, 0, 'grouped not imported');

  update inv.settings set value = 'all' where key = 'track_stock_mode';
  perform inv.upsert_items_from_catalog();
  perform t.eq((select track_stock from inv.item where sku = 'T-OFF'), true, 'all mode tracks manage_stock false');
  perform t.eq((select track_stock from inv.item where sku = 'T-RENT'), false, 'all mode still excludes the root');
  perform t.eq((select track_stock from inv.item where sku = 'T-MIX'), true, 'one kept root is enough');
  perform t.eq((select track_stock from inv.item where sku = 'T-CHILD'), false, 'all mode excludes the child');
  perform t.eq((select track_stock from inv.item where sku = 'T-BND'), false, 'all mode skips bundle type');
  perform t.eq((select track_stock from inv.item where sku = 'T-BPARENT'), false, 'all mode skips bundle parent');
  perform t.eq((select track_stock from inv.item where sku = 'T-COMP'), true, 'component still tracked');
  perform t.eq((select track_stock from inv.item where sku = 'T-VAR-P'), true, 'all mode tracks parent-managed variation');
  perform t.eq((select track_stock from inv.item where sku = 'T-ON'), true, 'already tracked stays tracked');
end $$;

-- Unrecognized bundle columns are a validation error, not a silent skip.
drop table public.bundle_components;
create table public.bundle_components (note text);
do $$ begin
  perform t.ok(t.expect_error('select inv.upsert_items_from_catalog()', 'VALIDATION') like '%bundle_product_id%',
    'bad bundle columns');
end $$;

-- No categories table: payload slugs are the roots.
drop table public.bundle_components;
drop table public.product_categories;
drop table public.categories;
delete from public.product_variations;
delete from public.products;
insert into public.products (id, slug, name, sku, type, status, source_payload) values
  (30, 'pay-rent', 'Pay rent', 'PAY-RENT', 'simple', 'published', '{"manage_stock": true, "categories": [{"slug": "utleie"}]}'),
  (31, 'pay-mix', 'Pay mix', 'PAY-MIX', 'simple', 'published', '{"manage_stock": false, "categories": [{"slug": "Utleie"}, {"slug": "kniver"}]}'),
  (32, 'pay-none', 'Pay none', 'PAY-NONE', 'simple', 'published', '{"manage_stock": false}');

do $$ begin
  perform inv.upsert_items_from_catalog();
  perform t.eq((select track_stock from inv.item where sku = 'PAY-RENT'), false, 'payload slug excluded');
  perform t.eq((select track_stock from inv.item where sku = 'PAY-MIX'), true, 'payload mixed roots tracked');
  perform t.eq((select track_stock from inv.item where sku = 'PAY-NONE'), true, 'no category is not excluded');
end $$;

drop table public.product_variations, public.products;

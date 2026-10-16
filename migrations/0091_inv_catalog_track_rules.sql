-- inventory-ledger v0.6.0
-- =============================================================================
-- 0091_inv_catalog_track_rules.sql — which catalog items the ledger tracks
-- =============================================================================
-- Until v0.5 the storefront adapter tracked exactly the items that have Woo
-- `manage_stock` on. Shops that move stock mastery to the ledger (Bark, the
-- Handelsgutane shops) usually have `manage_stock` off everywhere, so every item
-- became "Not tracked". Two settings now decide tracking:
--
--   track_stock_mode               'woo_manage_stock' (default, v0.5 behaviour) | 'all'
--   track_exclude_category_slugs   comma-separated ROOT category slugs never tracked,
--                                  e.g. 'utleie' for rental. Empty = none.
--
-- Rules, applied in order (variations inherit the parent's categories and bundle flag):
--   1. bundles (products.bundle_components is not null) are never tracked —
--      orders are exploded into component SKUs, which are tracked instead;
--   2. an item whose categories ALL sit under excluded roots is not tracked
--      (an item under at least one non-excluded root is still tracked;
--       an item with no categories is never excluded);
--   3. mode 'all' → tracked; mode 'woo_manage_stock' → Woo manage_stock = true.
--
-- Optional mirror columns (public.categories, products.categories,
-- products.bundle_components) are detected at run time, so the adapter works on
-- mirrors that lack them. The Woo push now also sends manage_stock = true, so a
-- tracked item gets stock management switched on in Woo at the first push.
-- =============================================================================

insert into inv.settings (key, value) values
  ('track_stock_mode',             'woo_manage_stock'),
  ('track_exclude_category_slugs', '')
on conflict (key) do nothing;

create or replace function inv.upsert_items_from_catalog() returns jsonb
language plpgsql as $$
declare
  v_items   jsonb;
  v_mode    text := coalesce(nullif(inv._setting('track_stock_mode'), ''), 'woo_manage_stock');
  v_exclude text[] := coalesce(string_to_array(replace(coalesce(inv._setting('track_exclude_category_slugs'), ''), ' ', ''), ','), '{}');
  v_has_cats   boolean;
  v_has_bundle boolean;
  v_roots   text;
  v_bundle  text;
begin
  if to_regclass('public.products') is null then
    perform inv._raise('VALIDATION', 'storefront mirror public.products not found in this database');
  end if;
  if v_mode not in ('woo_manage_stock', 'all') then
    perform inv._raise('VALIDATION', format('track_stock_mode must be woo_manage_stock or all, got %s', v_mode));
  end if;
  v_exclude := array_remove(v_exclude, '');

  select to_regclass('public.categories') is not null
         and exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'products' and column_name = 'categories')
    into v_has_cats;
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'products' and column_name = 'bundle_components')
    into v_has_bundle;

  -- Root slugs per product (text[]), or an empty array when the mirror has no category data.
  v_roots := case when v_has_cats then $r$
      coalesce((
        with recursive up as (
          select c.id, c.parent_id, c.slug, 0 as depth
            from public.categories c where c.id = any (p.categories)
          union all
          select c.id, c.parent_id, c.slug, up.depth + 1
            from public.categories c join up on c.id = up.parent_id
           where up.depth < 20
        )
        select array_agg(distinct u.slug) from up u where u.parent_id is null
      ), '{}'::text[])
    $r$ else $r$ '{}'::text[] $r$ end;
  v_bundle := case when v_has_bundle then 'p.bundle_components is not null' else 'false' end;

  execute format($sql$
    with prod as (
      select p.*, %1$s as roots, %2$s as is_bundle from public.products p
    ),
    src as (
      select p.sku, p.id as woo_product_id, null::bigint as woo_variation_id, p.name,
             coalesce(p.source_payload->>'manage_stock', 'false') = 'true' as woo_managed,
             p.status in ('published', 'publish', 'private') as active,
             p.roots, p.is_bundle
        from prod p
       where p.type = 'simple'
      union all
      select v.sku, v.parent_id, v.id,
             p.name || coalesce(' – ' || (
               select string_agg(x.value, ' / ' order by x.key)
                 from jsonb_each_text(case when jsonb_typeof(v.attributes) = 'object' then v.attributes else '{}'::jsonb end) x
             ), ''),
             coalesce(v.source_payload->>'manage_stock', 'false') = 'true',
             p.status in ('published', 'publish', 'private')
               and coalesce(v.source_payload->>'status', 'publish') in ('publish', 'published', 'private'),
             p.roots, p.is_bundle
        from public.product_variations v
        join prod p on p.id = v.parent_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'sku', s.sku, 'woo_product_id', s.woo_product_id, 'woo_variation_id', s.woo_variation_id,
             'name', s.name, 'active', s.active,
             'track_stock', case
               when s.is_bundle then false
               when cardinality($1) > 0 and cardinality(s.roots) > 0 and s.roots <@ $1 then false
               when $2 = 'all' then true
               else s.woo_managed end)), '[]'::jsonb)
      from src s
  $sql$, v_roots, v_bundle) into v_items using v_exclude, v_mode;

  return inv.upsert_items(jsonb_build_object('items', v_items, 'deactivate_missing', true))
         || jsonb_build_object('source', 'storefront_mirror', 'mirror_rows', jsonb_array_length(v_items),
                               'track_stock_mode', v_mode, 'track_exclude_category_slugs', to_jsonb(v_exclude));
end $$;

revoke execute on function inv.upsert_items_from_catalog() from public;

update inv.settings set value = '0.6.0', updated_at = now() where key = 'schema_version';

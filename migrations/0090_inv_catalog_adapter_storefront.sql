-- inventory-ledger v0.6.0
-- =============================================================================
-- 0090_inv_catalog_adapter_storefront.sql — items from the storefront Supabase mirror
-- =============================================================================
-- `inv` always lives in the same Supabase as the storefront (skarpekniverv3 / barkavenue).
-- Both have the same mirror: public.products (+ public.product_variations) with
-- source_payload = the full Woo response. The adapter turns the mirror into inv.item:
--   * simple products → one item; variable → one item per variation (the parent is skipped)
--   * track_stock = Woo manage_stock === true (a variation with 'parent' → false)
-- v0.6.0 replaces this function in 0091_inv_v060.sql (mode, excluded roots, bundles).
-- This body stays so a database that already applied 0090 still has the function
-- until 0091 runs. Fresh installs end on the 0091 definition.
--   * active      = published/private (and the variation is not draft/hidden)
--   * items gone from the mirror are deactivated (deactivate_missing)
-- The function is validated at execution time, so the migration tolerates a missing mirror.
-- =============================================================================

create or replace function inv.upsert_items_from_catalog() returns jsonb
language plpgsql as $$
declare v_items jsonb;
begin
  if to_regclass('public.products') is null then
    perform inv._raise('VALIDATION', 'storefront mirror public.products not found in this database');
  end if;

  execute $sql$
    with src as (
      select p.sku,
             p.id               as woo_product_id,
             null::bigint       as woo_variation_id,
             p.name,
             coalesce(p.source_payload->>'manage_stock', 'false') = 'true' as track_stock,
             p.status in ('published', 'publish', 'private')               as active
        from public.products p
       where p.type = 'simple'
      union all
      select v.sku,
             v.parent_id,
             v.id,
             p.name || coalesce(' – ' || (
               select string_agg(x.value, ' / ' order by x.key)
                 from jsonb_each_text(case when jsonb_typeof(v.attributes) = 'object' then v.attributes else '{}'::jsonb end) x
             ), ''),
             coalesce(v.source_payload->>'manage_stock', 'false') = 'true',
             p.status in ('published', 'publish', 'private')
               and coalesce(v.source_payload->>'status', 'publish') in ('publish', 'published', 'private')
        from public.product_variations v
        join public.products p on p.id = v.parent_id
    )
    select coalesce(jsonb_agg(to_jsonb(src)), '[]'::jsonb) from src
  $sql$ into v_items;

  return inv.upsert_items(jsonb_build_object('items', v_items, 'deactivate_missing', true))
         || jsonb_build_object('source', 'storefront_mirror', 'mirror_rows', jsonb_array_length(v_items));
end $$;

revoke execute on function inv.upsert_items_from_catalog() from public;

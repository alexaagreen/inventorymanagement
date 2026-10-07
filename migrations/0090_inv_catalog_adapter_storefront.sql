-- inventory-ledger v0.5.0
-- =============================================================================
-- 0090_inv_catalog_adapter_storefront.sql — varer fra nettbutikkens Supabase-speil
-- =============================================================================
-- `inv` bor alltid i samme Supabase som nettbutikken (skarpekniverv3 / barkavenue).
-- Begge har samme speil: public.products (+ public.product_variations) med
-- source_payload = full Woo-respons. Adapteren gjør speilet til inv.item:
--   * simple-produkter → én vare;  variable → én vare per variasjon (parent hoppes over)
--   * track_stock = Woo manage_stock === true (variasjon med 'parent' → false)
--   * active      = publisert/privat (og variasjonen ikke er draft/private-skjult)
--   * varer som er borte fra speilet deaktiveres (deactivate_missing)
-- Funksjonen valideres først ved kjøring, så migrasjonen tåler at speilet mangler.
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

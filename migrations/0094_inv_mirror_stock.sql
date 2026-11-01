-- inventory-ledger v0.8.0
-- =============================================================================
-- 0094_inv_mirror_stock.sql — write pushed stock straight into the storefront mirror
-- =============================================================================
-- The storefronts read stock from the Supabase mirror (public.products /
-- public.product_variations), which is normally refreshed by the storefront's own
-- Woo → Supabase sync (webhook or cron). After the ledger pushes stock to Woo, the
-- mirror would lag until that sync runs. apply_mirror_stock() closes the gap: the
-- push worker calls it with Woo's batch response, so the mirror gets exactly what
-- Woo now holds (stock_quantity, stock_status, manage_stock) in the same second.
--
-- * Only stock fields are touched: stock_quantity, stock_status and the same keys
--   inside source_payload. Prices, names, categories etc. stay owned by the sync.
-- * Woo's stock_status ('instock' | 'outofstock' | 'onbackorder') is mapped to the
--   mirror's form ('in_stock' | 'out_of_stock' | 'on_backorder'), like the mappers.
-- * Columns are detected at run time; a mirror without them is simply skipped.
-- * Setting mirror_stock_update ('true' default) turns it off per shop.
-- * The storefront sync later writes the same values again — harmless.
-- =============================================================================

insert into inv.settings (key, value) values ('mirror_stock_update', 'true')
on conflict (key) do nothing;

create or replace function inv._mirror_stock_status(p text) returns text
language sql immutable as $$
  select case p when 'instock' then 'in_stock'
                when 'outofstock' then 'out_of_stock'
                when 'onbackorder' then 'on_backorder'
                else p end
$$;

-- p: { products:   [{ id, stock_quantity, stock_status?, manage_stock? }],
--      variations: [{ id, stock_quantity, stock_status?, manage_stock? }] }
-- → { products: n, variations: n } rows updated, or { skipped: reason }.
create or replace function inv.apply_mirror_stock(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_out jsonb := '{}';
  v_tbl text;
  v_key text;
  v_has_qty boolean; v_has_status boolean; v_has_payload boolean;
  v_set text;
  v_n int;
begin
  if not inv._setting_bool('mirror_stock_update') then
    return jsonb_build_object('skipped', 'mirror_stock_update is off');
  end if;
  foreach v_key in array array['products', 'variations'] loop
    v_tbl := case v_key when 'products' then 'products' else 'product_variations' end;
    if jsonb_typeof(p->v_key) <> 'array' or jsonb_array_length(p->v_key) = 0 then continue; end if;
    if to_regclass('public.' || v_tbl) is null then
      v_out := v_out || jsonb_build_object(v_key, 0); continue;
    end if;
    select bool_or(column_name = 'stock_quantity'), bool_or(column_name = 'stock_status'), bool_or(column_name = 'source_payload')
      into v_has_qty, v_has_status, v_has_payload
      from information_schema.columns where table_schema = 'public' and table_name = v_tbl;
    v_set := concat_ws(', ',
      case when v_has_qty then 'stock_quantity = x.stock_quantity' end,
      case when v_has_status then 'stock_status = coalesce(inv._mirror_stock_status(x.stock_status), t.stock_status)' end,
      case when v_has_payload then $s$source_payload = t.source_payload || jsonb_strip_nulls(jsonb_build_object(
             'stock_quantity', x.stock_quantity, 'stock_status', x.stock_status, 'manage_stock', x.manage_stock))$s$ end);
    if v_set is null or v_set = '' then v_out := v_out || jsonb_build_object(v_key, 0); continue; end if;
    execute format($q$
      update public.%I t set %s
        from jsonb_to_recordset($1) as x(id bigint, stock_quantity int, stock_status text, manage_stock boolean)
       where t.id = x.id
    $q$, v_tbl, v_set) using p->v_key;
    get diagnostics v_n = row_count;
    v_out := v_out || jsonb_build_object(v_key, v_n);
  end loop;
  return v_out;
end $$;

revoke execute on function inv.apply_mirror_stock(jsonb) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema inv from %I', r);
    end if;
  end loop;
end $$;

update inv.settings set value = '0.8.0', updated_at = now() where key = 'schema_version';

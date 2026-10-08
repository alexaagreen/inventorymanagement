-- inventory-ledger v0.6.0
-- =============================================================================
-- 0091_inv_v060.sql — which products are tracked, opening-balance cost, version
-- Runs after 0090 so this definition of inv.upsert_items_from_catalog() is the one
-- left installed. A Woo type of bundle is never tracked, same as a bundle parent.
-- =============================================================================
-- track_stock_mode
--   woo_manage_stock (default) — track_stock follows Woo manage_stock = true.
--     A variation whose manage_stock is "parent" is not tracked.
--   all — track every product, then turn Woo manage_stock on when pushing.
-- track_exclude_category_slugs
--   Comma-separated root category slugs that are never tracked (e.g. utleie).
--   A product under several roots is tracked when at least one root is not excluded.
--   A product with no category is not excluded.
-- Bundles (the parent product of a public.bundle_components row) are never tracked.
--   Component products are tracked under the rules above. Recognized bundle columns,
--   in order: bundle_product_id, bundle_id, or product_id when a component column
--   (component_product_id or component_id) is also present.
-- Category roots come from public.categories (id, slug, parent_id) joined via
--   public.product_categories (product_id, category_id). If the junction table is
--   missing, category ids in products.source_payload.categories are walked instead.
--   With no categories table, those payload slugs are treated as roots.
-- Opening balance: an empty unit_cost uses the inbound cost chain (on-hand average,
--   last purchase, last known) and falls back to 0 / unknown when the item has no
--   cost history. qty must be > 0 — a zero-qty row is a validation error and the
--   whole import is rejected (the ledger cannot store a zero-qty movement).
--   Numeric strings accept a decimal comma (12,5) and nb-NO thousands (1.234,56).
-- =============================================================================

insert into inv.settings (key, value) values
  ('track_stock_mode', 'woo_manage_stock'),
  ('track_exclude_category_slugs', '')
on conflict (key) do nothing;

-- Decimal comma, so a CSV cell "12,5" is a number. Empty stays null.
create or replace function inv._jnum(p jsonb, k text) returns numeric
language plpgsql immutable as $$
declare v text := nullif(btrim(p ->> k), '');
begin
  if v is null then return null; end if;
  v := replace(replace(v, ' ', ''), chr(160), '');
  if position(',' in v) > 0 and position('.' in v) > 0 then
    v := replace(replace(v, '.', ''), ',', '.');
  elsif position(',' in v) > 0 then
    v := replace(v, ',', '.');
  end if;
  begin
    return v::numeric;
  exception when others then
    perform inv._raise('VALIDATION', format('%s must be a number', k), jsonb_build_object('field', k, 'value', p ->> k));
  end;
end $$;

create or replace function inv.import_opening_balance(p jsonb) returns jsonb
language plpgsql as $$
declare
  e          jsonb;
  v_i        int := 0;
  v_item     uuid;
  v_loc      uuid;
  v_qty      numeric;
  v_cost     numeric;
  v_src      text;
  v_ref      text;
  v_errors   jsonb := '[]';
  v_rows     jsonb := '[]';
  v_dry      boolean := coalesce((p->>'dry_run')::boolean, false);
  v_at       timestamptz := coalesce(inv._jts(p, 'occurred_at'), now());
  v_imported int := 0;
  v_existing int := 0;
  v_value    numeric := 0;
  r          jsonb;
begin
  if jsonb_typeof(p->'rows') <> 'array' or jsonb_array_length(p->'rows') = 0 then
    perform inv._raise('VALIDATION', 'rows must be a non-empty array');
  end if;

  for e in select * from jsonb_array_elements(p->'rows') loop
    v_i := v_i + 1;
    begin
      v_item := inv._resolve_item(inv._jtext(e, 'sku'));
      v_loc  := inv._resolve_location(inv._jtext(e, 'location'));
      v_qty  := inv._jnum(e, 'qty');
      v_cost := inv._jnum(e, 'unit_cost');
      -- qty 0 is not an opening layer. The row fails and nothing in the file is written.
      if v_qty is null or v_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0'); end if;
      if v_cost is null then
        begin
          select c.unit_cost, c.cost_source into v_cost, v_src
            from inv._resolve_in_cost(v_item, v_loc, null) c;
        exception when sqlstate 'P0001' then
          if sqlerrm not like 'COST_REQUIRED:%' then raise; end if;
          v_cost := 0;
          v_src := 'unknown';
        end;
      else
        if v_cost < 0 then perform inv._raise('VALIDATION', 'unit_cost must be >= 0'); end if;
        v_src := 'manual';
      end if;
      v_ref := inv._sku(v_item) || ':' || inv._loc_code(v_loc);
      if v_rows @> jsonb_build_array(jsonb_build_object('ref', v_ref)) then
        perform inv._raise('VALIDATION', format('duplicate row for %s', v_ref));
      end if;
      v_rows := v_rows || jsonb_build_object(
        'row', v_i, 'ref', v_ref, 'item_id', v_item, 'location_id', v_loc,
        'sku', inv._sku(v_item), 'name', (select name from inv.item where id = v_item),
        'location', inv._loc_code(v_loc), 'qty', v_qty, 'unit_cost', v_cost,
        'cost_source', v_src, 'value', round(v_qty * v_cost, 2),
        'existing', inv._existing_ref('opening_balance', v_ref, null) is not null);
    exception when sqlstate 'P0001' then
      v_errors := v_errors || jsonb_build_object('row', v_i, 'sku', e->>'sku', 'message', regexp_replace(sqlerrm, '^[A-Z_]+:\s*', ''));
    end;
  end loop;

  if jsonb_array_length(v_errors) > 0 or v_dry then
    return jsonb_build_object(
      'ok', jsonb_array_length(v_errors) = 0, 'dry_run', v_dry, 'errors', v_errors,
      'rows', v_rows, 'total_value', (select coalesce(sum((x->>'value')::numeric), 0) from jsonb_array_elements(v_rows) x));
  end if;

  for r in select * from jsonb_array_elements(v_rows) loop
    if (r->>'existing')::boolean then v_existing := v_existing + 1; continue; end if;
    perform inv._post_in((r->>'item_id')::uuid, (r->>'location_id')::uuid, 'opening_balance',
      jsonb_build_array(jsonb_build_object('qty', (r->>'qty')::numeric, 'unit_cost', (r->>'unit_cost')::numeric, 'received_at', v_at)),
      r->>'cost_source', 'opening_balance', r->>'ref', null, 'Opening balance', null, inv._jtext(p, 'by'), v_at, null);
    v_imported := v_imported + 1;
    v_value := v_value + (r->>'value')::numeric;
  end loop;

  return jsonb_build_object('ok', true, 'dry_run', false, 'errors', '[]'::jsonb,
    'imported', v_imported, 'existing', v_existing, 'imported_value', v_value);
end $$;

-- English movement notes for databases that already applied the v0.5 function bodies.
do $$
declare src text;
begin
  src := pg_get_functiondef('inv.apply_woo_order(jsonb,text)'::regprocedure);
  if position('Ordrelinje redusert' in src) > 0 or position('''Ordre ''' in src) > 0 then
    src := replace(src, 'Ordrelinje redusert', 'Order line reduced');
    src := replace(src, '''Ordre ''', '''Order ''');
    execute src;
  end if;
  src := pg_get_functiondef('inv.apply_woo_refund(bigint,jsonb)'::regprocedure);
  if position('''Refusjon ''' in src) > 0 then
    src := replace(src, '''Refusjon ''', '''Refund ''');
    execute src;
  end if;
end $$;

create or replace function inv.upsert_items_from_catalog() returns jsonb
language plpgsql as $$
declare
  v_items    jsonb;
  v_mode     text;
  v_bundle_col text;
  v_has_categories boolean;
  v_has_junction boolean;
  v_has_cat_cols boolean;
  v_bundle_sql text;
  v_roots_sql text;
begin
  if to_regclass('public.products') is null then
    perform inv._raise('VALIDATION', 'storefront mirror public.products not found in this database');
  end if;

  v_mode := lower(btrim(coalesce(inv._setting('track_stock_mode'), 'woo_manage_stock')));
  if v_mode not in ('woo_manage_stock', 'all') then
    v_mode := 'woo_manage_stock';
  end if;

  v_bundle_col := null;
  if to_regclass('public.bundle_components') is not null then
    select c.column_name into v_bundle_col
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'bundle_components'
       and c.column_name in ('bundle_product_id', 'bundle_id')
     order by case c.column_name when 'bundle_product_id' then 1 else 2 end
     limit 1;
    if v_bundle_col is null
       and exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'bundle_components' and column_name = 'product_id')
       and exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'bundle_components'
                      and column_name in ('component_product_id', 'component_id')) then
      v_bundle_col := 'product_id';
    end if;
    if v_bundle_col is null then
      perform inv._raise('VALIDATION',
        'public.bundle_components needs bundle_product_id, bundle_id, or product_id plus a component column');
    end if;
    v_bundle_sql := format(
      'select distinct %I::bigint as product_id from public.bundle_components where %I is not null',
      v_bundle_col, v_bundle_col);
  else
    v_bundle_sql := 'select null::bigint as product_id where false';
  end if;

  v_has_cat_cols := to_regclass('public.categories') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'categories' and column_name = 'id')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'categories' and column_name = 'slug')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'categories' and column_name = 'parent_id');
  v_has_junction := to_regclass('public.product_categories') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_categories' and column_name = 'product_id')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_categories' and column_name = 'category_id');
  v_has_categories := v_has_cat_cols;

  if v_has_categories and v_has_junction then
    v_roots_sql := $roots$
      with recursive walk as (
        select pc.product_id, c.id, c.parent_id, lower(c.slug) as slug, 0 as depth
          from public.product_categories pc
          join public.categories c on c.id = pc.category_id
        union all
        select w.product_id, p.id, p.parent_id, lower(p.slug), w.depth + 1
          from walk w
          join public.categories p on p.id = w.parent_id
         where w.parent_id is not null and w.parent_id <> 0 and w.depth < 20
      )
      select distinct w.product_id, w.slug as root_slug
        from walk w
       where w.slug is not null and w.slug <> ''
         and (w.parent_id is null or w.parent_id = 0
              or not exists (select 1 from public.categories c where c.id = w.parent_id))
    $roots$;
  elsif v_has_categories then
    v_roots_sql := $roots$
      with recursive assigned as (
        select p.id as product_id, (cat->>'id')::bigint as category_id
          from public.products p
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(p.source_payload->'categories') = 'array'
                 then p.source_payload->'categories' else '[]'::jsonb end) cat
         where coalesce(cat->>'id', '') ~ '^[0-9]+$'
      ),
      walk as (
        select a.product_id, c.id, c.parent_id, lower(c.slug) as slug, 0 as depth
          from assigned a
          join public.categories c on c.id = a.category_id
        union all
        select w.product_id, p.id, p.parent_id, lower(p.slug), w.depth + 1
          from walk w
          join public.categories p on p.id = w.parent_id
         where w.parent_id is not null and w.parent_id <> 0 and w.depth < 20
      )
      select distinct w.product_id, w.slug as root_slug
        from walk w
       where w.slug is not null and w.slug <> ''
         and (w.parent_id is null or w.parent_id = 0
              or not exists (select 1 from public.categories c where c.id = w.parent_id))
    $roots$;
  else
    v_roots_sql := $roots$
      select p.id as product_id, lower(cat->>'slug') as root_slug
        from public.products p
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(p.source_payload->'categories') = 'array'
               then p.source_payload->'categories' else '[]'::jsonb end) cat
       where coalesce(cat->>'slug', '') <> ''
    $roots$;
  end if;

  execute format($sql$
    with excluded as (
      select lower(btrim(s)) as slug
        from unnest(string_to_array(coalesce(inv._setting('track_exclude_category_slugs'), ''), ',')) s
       where btrim(s) <> ''
    ),
    bundles as (%s),
    roots as (%s),
    root_stats as (
      select product_id,
             count(*) as root_count,
             count(*) filter (where root_slug not in (select slug from excluded)) as kept_count
        from roots
       group by product_id
    ),
    src as (
      select p.sku,
             p.id as woo_product_id,
             null::bigint as woo_variation_id,
             p.name,
             case
               when p.id in (select product_id from bundles) or lower(coalesce(p.type, '')) = 'bundle' then false
               when coalesce(rs.root_count, 0) > 0 and coalesce(rs.kept_count, 0) = 0 then false
               when %L = 'all' then true
               else coalesce(p.source_payload->>'manage_stock', 'false') = 'true'
             end as track_stock,
             p.status in ('published', 'publish', 'private') as active
        from public.products p
        left join root_stats rs on rs.product_id = p.id
       where p.type is distinct from 'variable'
         and (p.type in ('simple', 'bundle') or p.id in (select product_id from bundles))
      union all
      select v.sku,
             v.parent_id,
             v.id,
             p.name || coalesce(' – ' || (
               select string_agg(x.value, ' / ' order by x.key)
                 from jsonb_each_text(case when jsonb_typeof(v.attributes) = 'object' then v.attributes else '{}'::jsonb end) x
             ), ''),
             case
               when p.id in (select product_id from bundles) or lower(coalesce(p.type, '')) = 'bundle' then false
               when coalesce(rs.root_count, 0) > 0 and coalesce(rs.kept_count, 0) = 0 then false
               when %L = 'all' then true
               else coalesce(v.source_payload->>'manage_stock', 'false') = 'true'
             end,
             p.status in ('published', 'publish', 'private')
               and coalesce(v.source_payload->>'status', 'publish') in ('publish', 'published', 'private')
        from public.product_variations v
        join public.products p on p.id = v.parent_id
        left join root_stats rs on rs.product_id = p.id
    )
    select coalesce(jsonb_agg(to_jsonb(src)), '[]'::jsonb) from src
  $sql$, v_bundle_sql, v_roots_sql, v_mode, v_mode) into v_items;

  return inv.upsert_items(jsonb_build_object('items', v_items, 'deactivate_missing', true))
         || jsonb_build_object('source', 'storefront_mirror', 'mirror_rows', jsonb_array_length(v_items), 'track_stock_mode', v_mode);
end $$;

revoke execute on function inv._jnum(jsonb, text) from public;
revoke execute on function inv.import_opening_balance(jsonb) from public;
revoke execute on function inv.upsert_items_from_catalog() from public;

update inv.settings set value = '0.6.0', updated_at = now() where key = 'schema_version';

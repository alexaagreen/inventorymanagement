-- inventory-ledger v0.6.0
-- =============================================================================
-- 0092_inv_orders_skip_untracked.sql — orders ignore untracked items (opt-in)
-- =============================================================================
-- Until v0.6 every matched order line became a sale, also for items with
-- track_stock = false (spec T22: movements allowed, never pushed). For shops that
-- sell items the ledger must not count — rental (Randoutleie), bundles, services —
-- that polluted stock, negative-stock and COGS reports.
--
-- New setting orders_skip_untracked ('false' default = v0.5 behaviour):
--   'true' → order lines whose item has track_stock = false are skipped and listed
--            under ignored_untracked in the result (not as unmatched).
-- Refunds need no change: a skipped line never enters woo_order_sync.lines, so
-- there is nothing to return. Only apply_woo_order is replaced; the body is
-- 0004's with the skip added.
-- =============================================================================

insert into inv.settings (key, value) values ('orders_skip_untracked', 'false')
on conflict (key) do nothing;

create or replace function inv.apply_woo_order(o jsonb, p_source text default 'webhook') returns jsonb
language plpgsql as $$
declare
  v_order   bigint := (o->>'id')::bigint;
  v_status  text := o->>'status';
  v_ref     text;
  s         inv.woo_order_sync;
  v_deduct  boolean;
  v_restore boolean;
  v_loc     uuid;
  v_allow   boolean := inv._setting_bool('allow_negative_sale');
  v_by      text := 'system:woo-' || coalesce(p_source, 'webhook');
  v_number  text := coalesce(o->>'number', o->>'id');
  v_created timestamptz := coalesce(inv._woo_ts(o->>'date_created_gmt'), inv._woo_ts(o->>'date_created'));
  -- desired: line_id → {item_id, sku, qty}
  v_desired  jsonb := '{}';
  v_unmatched jsonb := '[]';
  v_ignored jsonb := '[]';
  v_skip    boolean := coalesce(inv._setting_bool('orders_skip_untracked'), false);
  v_lines   jsonb;          -- line_id → snapshot entry
  li        jsonb;
  v_line_id text;
  v_item    uuid;
  e         jsonb;
  v_want    numeric;
  v_ord     numeric;
  v_net     numeric;
  v_ref_qty numeric;
  v_seq     int;
  v_delta   numeric;
  v_mid     bigint;
  v_mids    bigint[] := '{}';
  v_action  text := 'ignored';
  v_uc      numeric;
  k         text;
begin
  if v_order is null then perform inv._raise('VALIDATION', 'order id is required'); end if;
  v_ref := v_order::text;
  v_deduct  := inv._csv_has(inv._setting('deduct_statuses'), v_status);
  v_restore := inv._csv_has(inv._setting('restore_statuses'), v_status);

  insert into inv.woo_order_sync (woo_order_id) values (v_order) on conflict do nothing;
  select * into s from inv.woo_order_sync where woo_order_id = v_order for update;

  v_loc := coalesce(s.location_id, inv._woo_order_location(o));

  -- Desired state from the payload
  for li in select * from jsonb_array_elements(coalesce(o->'line_items', '[]')) loop
    v_line_id := li->>'id';
    if v_line_id is null or coalesce((li->>'quantity')::numeric, 0) <= 0 then continue; end if;
    v_item := inv._woo_line_item(li);
    if v_item is null then
      v_unmatched := v_unmatched || jsonb_build_object('line_id', v_line_id, 'sku', li->>'sku',
        'product_id', li->'product_id', 'variation_id', li->'variation_id', 'name', li->>'name',
        'quantity', (li->>'quantity')::numeric);
      continue;
    end if;
    -- v0.6.0: untracked items (rental, bundles, …) stay out of the ledger entirely
    if v_skip and not (select i.track_stock from inv.item i where i.id = v_item) then
      v_ignored := v_ignored || jsonb_build_object('line_id', v_line_id, 'sku', inv._sku(v_item),
        'quantity', (li->>'quantity')::numeric);
      continue;
    end if;
    v_desired := v_desired || jsonb_build_object(v_line_id,
      jsonb_build_object('item_id', v_item, 'sku', inv._sku(v_item), 'qty', (li->>'quantity')::numeric));
  end loop;

  -- Snapshot as map line_id → entry
  select coalesce(jsonb_object_agg(x->>'line_id', x), '{}') into v_lines
    from jsonb_array_elements(s.lines) x;

  if v_deduct then
    -- Covers none → deducted, restored → deducted and diffs while deducted.
    for k in select key from (
               select jsonb_object_keys(v_desired) as key
               union select jsonb_object_keys(v_lines)) z
             order by length(key), key
    loop
      e := coalesce(v_lines->k, jsonb_build_object('line_id', k, 'item_id', v_desired->k->>'item_id',
             'sku', v_desired->k->>'sku', 'ordered', 0, 'net', 0, 'refunded', 0, 'seq', 0));
      v_item := (e->>'item_id')::uuid;
      v_want := coalesce((v_desired->k->>'qty')::numeric, 0);
      v_ord  := (e->>'ordered')::numeric;
      v_net  := (e->>'net')::numeric;
      v_seq  := (e->>'seq')::int;
      -- Target: net = ordered − refunded (refunded items must not be deducted again)
      v_delta := greatest(v_want - (e->>'refunded')::numeric, 0) - v_net;

      if v_delta > 0 then
        v_mid := inv._post_out(v_item, v_loc, 'sale', v_delta, v_allow,
          'woo_order', v_ref, case when v_seq = 0 then k else k || ':' || v_seq end,
          '#' || v_number, null, v_by,
          case when s.stock_state = 'none' and v_seq = 0 then coalesce(v_created, now()) else now() end,
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_net := v_net + v_delta;
        v_seq := v_seq + 1;
      elsif v_delta < 0 then
        v_uc := inv._sale_unit_cost(v_item, 'woo_order', v_ref, k);
        v_mid := inv._post_in(v_item, v_loc, 'sale_return',
          jsonb_build_array(jsonb_build_object('qty', -v_delta, 'unit_cost', coalesce(v_uc, (inv._resolve_in_cost(v_item, v_loc, null)).unit_cost))),
          case when v_uc is not null then 'sale_cogs' else 'on_hand_avg' end,
          'woo_order', v_ref, k || ':r' || v_seq, '#' || v_number, 'Ordrelinje redusert', v_by, now(),
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_net := v_net + v_delta;
        v_seq := v_seq + 1;
      end if;

      v_lines := v_lines || jsonb_build_object(k, e || jsonb_build_object(
        'ordered', v_want, 'net', v_net, 'seq', v_seq));
    end loop;

    v_action := case
      when s.stock_state = 'none' then 'deducted'
      when s.stock_state = 'restored' then 'deducted'
      when array_length(v_mids, 1) > 0 then 'adjusted'
      else 'ignored' end;
    s.stock_state := 'deducted';

  elsif v_restore and s.stock_state = 'deducted' then
    for k in select key from jsonb_object_keys(v_lines) key order by length(key), key loop
      e := v_lines->k;
      v_net := (e->>'net')::numeric;
      v_seq := (e->>'seq')::int;
      if v_net > 0 then
        v_item := (e->>'item_id')::uuid;
        v_uc := inv._sale_unit_cost(v_item, 'woo_order', v_ref, k);
        v_mid := inv._post_in(v_item, v_loc, 'sale_return',
          jsonb_build_array(jsonb_build_object('qty', v_net, 'unit_cost', coalesce(v_uc, (inv._resolve_in_cost(v_item, v_loc, null)).unit_cost))),
          case when v_uc is not null then 'sale_cogs' else 'on_hand_avg' end,
          'woo_order', v_ref, k || ':r' || v_seq, '#' || v_number, 'Ordre ' || v_status, v_by, now(),
          jsonb_build_object('woo_status', v_status, 'woo_line_id', k));
        v_mids := v_mids || v_mid;
        v_lines := v_lines || jsonb_build_object(k, e || jsonb_build_object('net', 0, 'seq', v_seq + 1));
      end if;
    end loop;
    s.stock_state := 'restored';
    v_action := 'restored';
  end if;

  update inv.woo_order_sync set
    woo_status = v_status,
    stock_state = s.stock_state,
    location_id = v_loc,
    lines = coalesce((select jsonb_agg(value order by key) from jsonb_each(v_lines)), '[]'),
    unmatched = v_unmatched,
    last_payload = o,
    processed_at = now()
  where woo_order_id = v_order;

  return jsonb_build_object(
    'order_id', v_order, 'status', v_status, 'action', v_action, 'stock_state', s.stock_state,
    'location', inv._loc_code(v_loc),
    'unmatched_skus', v_unmatched,
    'ignored_untracked', v_ignored,
    'movements', coalesce((select jsonb_agg(inv._movement_json(x) order by x) from unnest(v_mids) x), '[]'));
end $$;

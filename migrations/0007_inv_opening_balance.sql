-- inventory-ledger v0.5.0
-- =============================================================================
-- 0007_inv_opening_balance.sql — åpningsbalanse (spec §8 pkt 7)
-- =============================================================================
-- inv.import_opening_balance(p) med p = { rows: [{ sku, location?, qty, unit_cost }], by?, occurred_at?, dry_run? }
--   * Validerer ALLE rader først. Finnes én feil, skrives ingenting (alt-eller-ingenting).
--   * dry_run=true: returnerer forhåndsvisning (vare, lokasjon, verdi, om den alt er importert).
--   * Idempotent per (sku × lokasjon): ref_type='opening_balance', ref_id='<SKU>:<LOC>'.
--     En rad som alt er importert hoppes over (existing) — endringer gjøres med justering.
-- =============================================================================

create or replace function inv.import_opening_balance(p jsonb) returns jsonb
language plpgsql as $$
declare
  e        jsonb;
  v_i      int := 0;
  v_item   uuid;
  v_loc    uuid;
  v_qty    numeric;
  v_cost   numeric;
  v_ref    text;
  v_errors jsonb := '[]';
  v_rows   jsonb := '[]';
  v_dry    boolean := coalesce((p->>'dry_run')::boolean, false);
  v_at     timestamptz := coalesce(inv._jts(p, 'occurred_at'), now());
  v_imported int := 0;
  v_existing int := 0;
  v_value  numeric := 0;
  r        jsonb;
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
      if v_qty is null or v_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0'); end if;
      if v_cost is null or v_cost < 0 then perform inv._raise('VALIDATION', 'unit_cost must be >= 0'); end if;
      v_ref := inv._sku(v_item) || ':' || inv._loc_code(v_loc);
      if v_rows @> jsonb_build_array(jsonb_build_object('ref', v_ref)) then
        perform inv._raise('VALIDATION', format('duplicate row for %s', v_ref));
      end if;
      v_rows := v_rows || jsonb_build_object(
        'row', v_i, 'ref', v_ref, 'item_id', v_item, 'location_id', v_loc,
        'sku', inv._sku(v_item), 'name', (select name from inv.item where id = v_item),
        'location', inv._loc_code(v_loc), 'qty', v_qty, 'unit_cost', v_cost,
        'value', round(v_qty * v_cost, 2),
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
      'manual', 'opening_balance', r->>'ref', null, 'Åpningsbalanse', null, inv._jtext(p, 'by'), v_at, null);
    v_imported := v_imported + 1;
    v_value := v_value + (r->>'value')::numeric;
  end loop;

  return jsonb_build_object('ok', true, 'dry_run', false, 'errors', '[]'::jsonb,
    'imported', v_imported, 'existing', v_existing, 'imported_value', v_value);
end $$;

revoke execute on function inv.import_opening_balance(jsonb) from public;

-- Testhjelpere. Lastes før hver testfil (scripts/test-sql.sh).
create schema if not exists t;

-- Opprett vare
create or replace function t.item(p_sku text, p_woo bigint default null, p_var bigint default null) returns uuid
language sql as $$
  select (inv.upsert_item(jsonb_build_object('sku', p_sku, 'name', p_sku,
            'woo_product_id', p_woo, 'woo_variation_id', p_var))->>'id')::uuid
$$;

-- Mottak via PO (sent + receive) med gitt kost/dato
create or replace function t.receive(p_sku text, p_qty numeric, p_cost numeric,
  p_at timestamptz default now(), p_loc text default null) returns jsonb
language plpgsql as $$
declare po jsonb;
begin
  po := inv.create_purchase_order(jsonb_build_object('supplier_name', 'Test', 'location', p_loc,
          'lines', jsonb_build_array(jsonb_build_object('sku', p_sku, 'qty', p_qty, 'unit_cost', p_cost))));
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'sent', 'test');
  return inv.receive_purchase_order((po->>'id')::uuid, jsonb_build_object('by', 'test', 'received_at', p_at,
          'location', p_loc,
          'lines', jsonb_build_array(jsonb_build_object('sku', p_sku, 'qty', p_qty))));
end $$;

create or replace function t.on_hand(p_sku text, p_loc text default 'MAIN') returns numeric
language sql as $$
  select coalesce((select on_hand from inv.v_stock_by_location where sku = p_sku and location_code = p_loc), 0)
$$;

create or replace function t.value(p_sku text, p_loc text default 'MAIN') returns numeric
language sql as $$
  select coalesce((select value from inv.v_stock_by_location where sku = p_sku and location_code = p_loc), 0)
$$;

create or replace function t.eq(p_actual anyelement, p_expected anyelement, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERT FAILED: % — expected %, got %', p_msg, p_expected, p_actual;
  end if;
end $$;

create or replace function t.ok(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'ASSERT FAILED: %', p_msg; end if;
end $$;

-- Forvent at SQL feiler med gitt kode (prefiks i meldingen)
create or replace function t.expect_error(p_sql text, p_code text) returns text
language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
    if v_msg not like p_code || ':%' then
      raise exception 'ASSERT FAILED: expected error %, got: %', p_code, v_msg;
    end if;
    return v_msg;
  end;
  raise exception 'ASSERT FAILED: expected error % but statement succeeded: %', p_code, p_sql;
end $$;

create or replace function t.integrity() returns void
language plpgsql as $$
declare v jsonb := inv.verify_integrity();
begin
  if not (v->>'ok')::boolean then raise exception 'ASSERT FAILED: integrity %', v->'issues'; end if;
end $$;

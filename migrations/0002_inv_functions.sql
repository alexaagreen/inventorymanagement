-- inventory-ledger v0.1.0
-- =============================================================================
-- 0002_inv_functions.sql — kjernen: FIFO, dokumenter, reversering, vedlikehold
-- =============================================================================
-- Kilde: docs/spec.md §3–§5. All skriving går gjennom disse funksjonene.
--
-- Konvensjoner:
--   * Interne hjelpere har prefiks `_` og tar typede argumenter.
--   * Offentlige funksjoner tar/returnerer jsonb, slik at kontrakten er lik
--     fra pg (Next.js), supabase.rpc() og psql.
--   * Feil: RAISE med errcode P0001, message '<CODE>: <tekst>' og
--     detail = json. HTTP-laget mapper CODE → status (spec §6.0).
--   * Alle skrivinger låser inv.stock_balance-raden (item × location) FOR UPDATE.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Feil og oppslag
-- ---------------------------------------------------------------------------
create or replace function inv._raise(p_code text, p_message text, p_details jsonb default '{}')
returns void language plpgsql as $$
begin
  raise exception '%: %', p_code, p_message
    using errcode = 'P0001', detail = coalesce(p_details, '{}')::text;
end $$;

create or replace function inv._setting(p_key text) returns text
language sql stable as $$
  select value from inv.settings where key = p_key
$$;

create or replace function inv._setting_bool(p_key text) returns boolean
language sql stable as $$
  select coalesce(lower(inv._setting(p_key)) in ('true','1','yes','on'), false)
$$;

create or replace function inv._norm_sku(p_sku text) returns text
language sql immutable as $$ select upper(btrim(p_sku)) $$;

create or replace function inv._resolve_item(p_sku text) returns uuid
language plpgsql stable as $$
declare v uuid;
begin
  if p_sku is null or btrim(p_sku) = '' then
    perform inv._raise('VALIDATION', 'sku is required');
  end if;
  select id into v from inv.item where upper(btrim(sku)) = inv._norm_sku(p_sku);
  if v is null then
    perform inv._raise('ITEM_NOT_FOUND', format('item %s not found', p_sku), jsonb_build_object('sku', p_sku));
  end if;
  return v;
end $$;

create or replace function inv._resolve_location(p_code text) returns uuid
language plpgsql stable as $$
declare v uuid;
begin
  if p_code is null or btrim(p_code) = '' then
    select id into v from inv.location where is_default;
    if v is null then perform inv._raise('LOCATION_NOT_FOUND', 'no default location configured'); end if;
    return v;
  end if;
  select id into v from inv.location where code = upper(btrim(p_code)) and active;
  if v is null then
    perform inv._raise('LOCATION_NOT_FOUND', format('location %s not found', p_code), jsonb_build_object('location', p_code));
  end if;
  return v;
end $$;

create or replace function inv._sku(p_item uuid) returns text
language sql stable as $$ select sku from inv.item where id = p_item $$;

create or replace function inv._loc_code(p_loc uuid) returns text
language sql stable as $$ select code from inv.location where id = p_loc $$;

-- jsonb-hjelpere: tomme strenger behandles som null
create or replace function inv._jtext(p jsonb, k text) returns text
language sql immutable as $$ select nullif(btrim(p ->> k), '') $$;

create or replace function inv._jnum(p jsonb, k text) returns numeric
language plpgsql immutable as $$
declare v text := nullif(btrim(p ->> k), '');
begin
  if v is null then return null; end if;
  begin
    return v::numeric;
  exception when others then
    perform inv._raise('VALIDATION', format('%s must be a number', k), jsonb_build_object('field', k, 'value', v));
  end;
end $$;

create or replace function inv._jts(p jsonb, k text) returns timestamptz
language plpgsql stable as $$
declare v text := nullif(btrim(p ->> k), '');
begin
  if v is null then return null; end if;
  begin
    return v::timestamptz;
  exception when others then
    perform inv._raise('VALIDATION', format('%s must be a timestamp', k), jsonb_build_object('field', k, 'value', v));
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Saldo-lås og verdi
-- ---------------------------------------------------------------------------
create or replace function inv._lock_balance(p_item uuid, p_loc uuid) returns inv.stock_balance
language plpgsql as $$
declare b inv.stock_balance;
begin
  insert into inv.stock_balance (item_id, location_id) values (p_item, p_loc)
  on conflict do nothing;
  select * into b from inv.stock_balance where item_id = p_item and location_id = p_loc for update;
  return b;
end $$;

-- Verdi = Σ faktiske lag (udekket konsum bidrar ikke).
create or replace function inv._layer_value(p_item uuid, p_loc uuid) returns numeric
language sql stable as $$
  select coalesce(round(sum(qty_remaining * unit_cost), 2), 0)
  from inv.cost_layer where item_id = p_item and location_id = p_loc and qty_remaining > 0
$$;

create or replace function inv._refresh_balance(p_item uuid, p_loc uuid, p_delta numeric) returns numeric
language plpgsql as $$
declare v_on_hand numeric;
begin
  update inv.stock_balance
     set on_hand = on_hand + p_delta,
         value = inv._layer_value(p_item, p_loc),
         last_movement_at = now(),
         updated_at = now()
   where item_id = p_item and location_id = p_loc
  returning on_hand into v_on_hand;
  return v_on_hand;
end $$;

-- ---------------------------------------------------------------------------
-- Kostkilder (spec §3.3, §3.5)
-- ---------------------------------------------------------------------------
-- Vektet snitt av lag med beholdning. p_loc null = alle lokasjoner.
create or replace function inv._avg_layer_cost(p_item uuid, p_loc uuid) returns numeric
language sql stable as $$
  select round(sum(qty_remaining * unit_cost) / nullif(sum(qty_remaining), 0), 4)
  from inv.cost_layer
  where item_id = p_item and qty_remaining > 0
    and (p_loc is null or location_id = p_loc)
$$;

create or replace function inv._last_purchase_cost(p_item uuid) returns numeric
language sql stable as $$
  select unit_cost from inv.movement
  where item_id = p_item and type = 'purchase_receipt' and unit_cost is not null and reversed_by is null
  order by occurred_at desc, id desc limit 1
$$;

create or replace function inv._last_known_cost(p_item uuid) returns numeric
language sql stable as $$
  select unit_cost from inv.cost_layer where item_id = p_item
  order by received_at desc, id desc limit 1
$$;

-- Kostregel for inngående bevegelse uten oppgitt kost (spec §3.3 pkt 1–6).
-- Returnerer (unit_cost, cost_source). Kaster COST_REQUIRED hvis ingenting finnes.
create or replace function inv._resolve_in_cost(p_item uuid, p_loc uuid, p_given numeric,
  out unit_cost numeric, out cost_source text)
language plpgsql stable as $$
begin
  if p_given is not null then
    if p_given < 0 then perform inv._raise('VALIDATION', 'unit_cost cannot be negative'); end if;
    unit_cost := p_given; cost_source := 'manual'; return;
  end if;
  unit_cost := inv._avg_layer_cost(p_item, p_loc);
  if unit_cost is not null then cost_source := 'on_hand_avg'; return; end if;
  unit_cost := inv._avg_layer_cost(p_item, null);
  if unit_cost is not null then cost_source := 'on_hand_avg_all'; return; end if;
  unit_cost := inv._last_purchase_cost(p_item);
  if unit_cost is not null then cost_source := 'last_purchase'; return; end if;
  unit_cost := inv._last_known_cost(p_item);
  if unit_cost is not null then cost_source := 'last_known'; return; end if;
  perform inv._raise('COST_REQUIRED', format('no cost history for %s — unit_cost is required', inv._sku(p_item)),
    jsonb_build_object('sku', inv._sku(p_item)));
end $$;

-- Estimert kost for udekket konsum (spec §3.5). Faller tilbake til 0/unknown.
create or replace function inv._estimate_cost(p_item uuid, p_avg_before numeric,
  out unit_cost numeric, out cost_source text)
language plpgsql stable as $$
begin
  if p_avg_before is not null then unit_cost := p_avg_before; cost_source := 'on_hand_avg'; return; end if;
  unit_cost := inv._last_purchase_cost(p_item);
  if unit_cost is not null then cost_source := 'last_purchase'; return; end if;
  unit_cost := inv._last_known_cost(p_item);
  if unit_cost is not null then cost_source := 'last_known'; return; end if;
  unit_cost := 0; cost_source := 'unknown';
end $$;

-- ---------------------------------------------------------------------------
-- Idempotens på (ref_type, ref_id, ref_line)
-- ---------------------------------------------------------------------------
create or replace function inv._existing_ref(p_ref_type text, p_ref_id text, p_ref_line text) returns bigint
language sql stable as $$
  select id from inv.movement
  where p_ref_type is not null
    and ref_type = p_ref_type and ref_id is not distinct from p_ref_id
    and ref_line is not distinct from p_ref_line
$$;

-- ---------------------------------------------------------------------------
-- Dekking av udekket konsum når et nytt lag kommer inn (spec §3.5)
-- ---------------------------------------------------------------------------
create or replace function inv._cover_open_consumption(p_layer_id bigint, p_in_movement bigint) returns void
language plpgsql as $$
declare
  l       inv.cost_layer;
  c       record;
  v_take  numeric;
  v_out   bigint;
begin
  select * into l from inv.cost_layer where id = p_layer_id for update;
  for c in
    select lc.*
      from inv.layer_consumption lc
      join inv.movement m on m.id = lc.movement_id
     where lc.layer_id is null and lc.covered_by_movement_id is null
       and m.item_id = l.item_id and m.location_id = l.location_id
     order by lc.id
     for update of lc
  loop
    exit when l.qty_remaining <= 0;
    v_take := least(l.qty_remaining, c.qty);
    v_out  := c.movement_id;

    if v_take < c.qty then
      -- Delvis dekking: original rad beholder rest (fortsatt udekket)
      update inv.layer_consumption set qty = qty - v_take where id = c.id;
      insert into inv.layer_consumption (movement_id, layer_id, qty, unit_cost, estimated, covered_by_movement_id)
      values (v_out, l.id, v_take, l.unit_cost, false, p_in_movement);
    else
      update inv.layer_consumption
         set layer_id = l.id, unit_cost = l.unit_cost, estimated = false,
             covered_by_movement_id = p_in_movement
       where id = c.id;
    end if;

    insert into inv.cogs_correction (movement_id, covered_by_movement_id, qty, estimated_unit_cost, actual_unit_cost, delta_cost)
    values (v_out, p_in_movement, v_take, c.unit_cost, l.unit_cost, round(v_take * (l.unit_cost - c.unit_cost), 2));

    l.qty_remaining := l.qty_remaining - v_take;
    update inv.cost_layer set qty_remaining = l.qty_remaining where id = l.id;

    -- Rekalkuler kost på det opprinnelige uttaket
    update inv.movement m
       set total_cost = s.total,
           unit_cost = round(s.total / abs(m.qty), 4),
           cost_estimated = s.any_open,
           cost_source = case when s.any_open then m.cost_source else 'fifo' end
      from (select round(sum(qty * unit_cost), 2) as total,
                   bool_or(layer_id is null and covered_by_movement_id is null) as any_open
              from inv.layer_consumption where movement_id = v_out) s
     where m.id = v_out;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Kjernen: inngående bevegelse (oppretter lag)
-- p_layers: [{qty, unit_cost, received_at?, source_layer_id?}].
-- p_unlayered_qty/cost: antall som legges til uten lag (kun reversering av
-- udekket konsum — beholdningen var negativ og nøytraliseres, ingen ny vare).
-- Bevegelsens antall = Σ lag + unlayered.
-- ---------------------------------------------------------------------------
create or replace function inv._post_in(
  p_item uuid, p_loc uuid, p_type inv.movement_type,
  p_layers jsonb, p_cost_source text,
  p_ref_type text, p_ref_id text, p_ref_line text, p_reference text,
  p_note text, p_by text, p_occurred_at timestamptz, p_metadata jsonb,
  p_reversal_of bigint default null,
  p_unlayered_qty numeric default 0,
  p_unlayered_cost numeric default 0
) returns bigint
language plpgsql as $$
declare
  v_id     bigint;
  v_qty    numeric := coalesce(p_unlayered_qty, 0);
  v_total  numeric := coalesce(p_unlayered_qty, 0) * coalesce(p_unlayered_cost, 0);
  v_layer  bigint;
  v_layers bigint[] := '{}';
  v_on_hand numeric;
  e        jsonb;
  v_at     timestamptz := coalesce(p_occurred_at, now());
begin
  p_layers := coalesce(p_layers, '[]'::jsonb);
  if jsonb_typeof(p_layers) <> 'array' or (jsonb_array_length(p_layers) = 0 and v_qty <= 0) then
    perform inv._raise('VALIDATION', 'inbound movement needs at least one layer');
  end if;
  for e in select * from jsonb_array_elements(p_layers) loop
    if (e->>'qty')::numeric <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0'); end if;
    if (e->>'unit_cost') is null or (e->>'unit_cost')::numeric < 0 then
      perform inv._raise('VALIDATION', 'unit_cost must be >= 0');
    end if;
    v_qty   := v_qty + (e->>'qty')::numeric;
    v_total := v_total + (e->>'qty')::numeric * (e->>'unit_cost')::numeric;
  end loop;

  perform inv._lock_balance(p_item, p_loc);

  insert into inv.movement (item_id, location_id, type, qty, unit_cost, total_cost, cost_source,
                            ref_type, ref_id, ref_line, reference, note, created_by, occurred_at,
                            reversal_of, metadata)
  values (p_item, p_loc, p_type, v_qty, round(v_total / v_qty, 4), round(v_total, 2), p_cost_source,
          p_ref_type, p_ref_id, p_ref_line, p_reference, p_note, p_by, v_at,
          p_reversal_of, coalesce(p_metadata, '{}'))
  returning id into v_id;

  for e in select * from jsonb_array_elements(p_layers) loop
    insert into inv.cost_layer (item_id, location_id, movement_id, qty_in, qty_remaining, unit_cost, received_at, source_layer_id)
    values (p_item, p_loc, v_id, (e->>'qty')::numeric, (e->>'qty')::numeric, (e->>'unit_cost')::numeric,
            coalesce((e->>'received_at')::timestamptz, v_at), (e->>'source_layer_id')::bigint)
    returning id into v_layer;
    v_layers := v_layers || v_layer;
  end loop;

  -- Dekk eventuelt udekket konsum (negativ beholdning) med de nye lagene, eldst-først.
  foreach v_layer in array v_layers loop
    perform inv._cover_open_consumption(v_layer, v_id);
  end loop;

  v_on_hand := inv._refresh_balance(p_item, p_loc, v_qty);
  perform inv._set_on_hand_after(v_id, v_on_hand);
  return v_id;
end $$;

-- on_hand_after settes én gang (null → verdi) etter at saldoen er oppdatert.
-- Guarden tillater bare det når flagget under er satt i transaksjonen.
create or replace function inv._set_on_hand_after(p_id bigint, p_value numeric) returns void
language plpgsql as $$
begin
  perform set_config('inv.allow_on_hand_after', 'on', true);
  update inv.movement set on_hand_after = p_value where id = p_id and on_hand_after is null;
  perform set_config('inv.allow_on_hand_after', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- Kjernen: utgående bevegelse (FIFO-konsum)
-- p_only_movement_layers: konsumér KUN lagene opprettet av denne bevegelsen
-- (reversering av inngang). Krever at lagene er urørte.
-- ---------------------------------------------------------------------------
create or replace function inv._post_out(
  p_item uuid, p_loc uuid, p_type inv.movement_type, p_qty numeric,
  p_allow_negative boolean,
  p_ref_type text, p_ref_id text, p_ref_line text, p_reference text,
  p_note text, p_by text, p_occurred_at timestamptz, p_metadata jsonb,
  p_reversal_of bigint default null,
  p_only_movement_layers bigint default null
) returns bigint
language plpgsql as $$
declare
  b           inv.stock_balance;
  v_id        bigint;
  v_rest      numeric := p_qty;
  v_take      numeric;
  v_total     numeric := 0;
  v_avg_before numeric;
  v_est       record;
  v_estimated boolean := false;
  v_source    text := 'fifo';
  v_on_hand   numeric;
  l           record;
begin
  if p_qty is null or p_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0'); end if;

  b := inv._lock_balance(p_item, p_loc);

  if p_only_movement_layers is null and not p_allow_negative and p_qty > b.on_hand then
    perform inv._raise('INSUFFICIENT_STOCK',
      format('only %s of %s on %s, cannot take %s', b.on_hand, inv._sku(p_item), inv._loc_code(p_loc), p_qty),
      jsonb_build_object('sku', inv._sku(p_item), 'location', inv._loc_code(p_loc),
                         'on_hand', b.on_hand, 'requested', p_qty));
  end if;

  v_avg_before := inv._avg_layer_cost(p_item, p_loc);

  insert into inv.movement (item_id, location_id, type, qty, cost_source,
                            ref_type, ref_id, ref_line, reference, note, created_by, occurred_at,
                            reversal_of, metadata)
  values (p_item, p_loc, p_type, -p_qty, 'fifo',
          p_ref_type, p_ref_id, p_ref_line, p_reference, p_note, p_by, coalesce(p_occurred_at, now()),
          p_reversal_of, coalesce(p_metadata, '{}'))
  returning id into v_id;

  for l in
    select * from inv.cost_layer
     where item_id = p_item and location_id = p_loc and qty_remaining > 0
       and (p_only_movement_layers is null or movement_id = p_only_movement_layers)
     order by received_at, id
     for update
  loop
    exit when v_rest <= 0;
    v_take := least(v_rest, l.qty_remaining);
    update inv.cost_layer set qty_remaining = qty_remaining - v_take where id = l.id;
    insert into inv.layer_consumption (movement_id, layer_id, qty, unit_cost)
    values (v_id, l.id, v_take, l.unit_cost);
    v_total := v_total + v_take * l.unit_cost;
    v_rest := v_rest - v_take;
  end loop;

  if v_rest > 0 then
    if p_only_movement_layers is not null then
      perform inv._raise('LAYER_CONSUMED', 'stock from this movement has already been consumed',
        jsonb_build_object('movement_id', p_only_movement_layers, 'missing', v_rest));
    end if;
    if not p_allow_negative then
      -- Skal ikke skje (sjekket over), men vær defensiv.
      perform inv._raise('INSUFFICIENT_STOCK', 'not enough layers', jsonb_build_object('missing', v_rest));
    end if;
    select * into v_est from inv._estimate_cost(p_item, v_avg_before);
    insert into inv.layer_consumption (movement_id, layer_id, qty, unit_cost, estimated)
    values (v_id, null, v_rest, v_est.unit_cost, true);
    v_total := v_total + v_rest * v_est.unit_cost;
    v_estimated := true;
    v_source := v_est.cost_source;
  end if;

  update inv.movement
     set total_cost = round(v_total, 2),
         unit_cost = round(v_total / p_qty, 4),
         cost_estimated = v_estimated,
         cost_source = v_source
   where id = v_id;

  v_on_hand := inv._refresh_balance(p_item, p_loc, -p_qty);
  perform inv._set_on_hand_after(v_id, v_on_hand);
  return v_id;
end $$;

-- Guarden må tillate on_hand_after null → verdi når flagget er satt.
create or replace function inv.movement_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: inv.movement rows cannot be deleted' using errcode = 'P0001';
  end if;
  if old.on_hand_after is distinct from new.on_hand_after
     and not (old.on_hand_after is null and current_setting('inv.allow_on_hand_after', true) = 'on') then
    raise exception 'IMMUTABLE: on_hand_after cannot change' using errcode = 'P0001';
  end if;
  if (new.id, new.item_id, new.location_id, new.type, new.qty, new.ref_type, new.ref_id,
      new.ref_line, new.reference, new.note, new.created_by, new.occurred_at,
      new.reversal_of, new.created_at)
     is distinct from
     (old.id, old.item_id, old.location_id, old.type, old.qty, old.ref_type, old.ref_id,
      old.ref_line, old.reference, old.note, old.created_by, old.occurred_at,
      old.reversal_of, old.created_at) then
    raise exception 'IMMUTABLE: only cost fields, reversed_by and metadata may change on inv.movement'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- JSON-presentasjon
-- ---------------------------------------------------------------------------
create or replace function inv._movement_json(p_id bigint) returns jsonb
language sql stable as $$
  select to_jsonb(m) - 'item_id' - 'location_id'
         || jsonb_build_object(
              'sku', i.sku, 'item_name', i.name, 'location', l.code,
              'kind', case
                when m.type in ('purchase_receipt','opening_balance') then 'innkjop'
                when m.type in ('sale','sale_return') then 'salg'
                when m.type in ('adjustment_in','adjustment_out','write_off') then 'justering'
                when m.type in ('transfer_in','transfer_out') then 'flytting'
                else 'reversering' end,
              'consumptions', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', c.id, 'layer_id', c.layer_id, 'qty', c.qty, 'unit_cost', c.unit_cost,
                          'estimated', c.estimated, 'covered_by_movement_id', c.covered_by_movement_id,
                          'layer_received_at', cl.received_at) order by c.id)
                 from inv.layer_consumption c left join inv.cost_layer cl on cl.id = c.layer_id
                 where c.movement_id = m.id), '[]'::jsonb),
              'layers', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', cl.id, 'qty_in', cl.qty_in, 'qty_remaining', cl.qty_remaining,
                          'unit_cost', cl.unit_cost, 'received_at', cl.received_at) order by cl.id)
                 from inv.cost_layer cl where cl.movement_id = m.id), '[]'::jsonb))
  from inv.movement m
  join inv.item i on i.id = m.item_id
  join inv.location l on l.id = m.location_id
  where m.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Varer
-- ---------------------------------------------------------------------------
create or replace function inv.upsert_item(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_sku   text := inv._jtext(p, 'sku');
  v_wp    bigint := (inv._jtext(p, 'woo_product_id'))::bigint;
  v_wv    bigint := (inv._jtext(p, 'woo_variation_id'))::bigint;
  v_id    uuid;
  r       inv.item;
begin
  if v_sku is null then perform inv._raise('VALIDATION', 'sku is required'); end if;

  if v_wp is not null then
    select id into v_id from inv.item
     where woo_product_id = v_wp and woo_variation_id is not distinct from v_wv;
  end if;
  if v_id is null then
    select id into v_id from inv.item where upper(btrim(sku)) = inv._norm_sku(v_sku);
  end if;

  if v_id is null then
    insert into inv.item (sku, woo_product_id, woo_variation_id, name, track_stock, active,
                          reorder_point, reorder_qty, attributes, synced_at)
    values (btrim(v_sku), v_wp, v_wv, inv._jtext(p, 'name'),
            coalesce((p->>'track_stock')::boolean, true), coalesce((p->>'active')::boolean, true),
            inv._jnum(p, 'reorder_point'), inv._jnum(p, 'reorder_qty'),
            coalesce(p->'attributes', '{}'), now())
    returning * into r;
  else
    update inv.item set
      sku              = btrim(v_sku),
      woo_product_id   = coalesce(v_wp, woo_product_id),
      woo_variation_id = case when v_wp is not null then v_wv else woo_variation_id end,
      name             = coalesce(inv._jtext(p, 'name'), name),
      track_stock      = coalesce((p->>'track_stock')::boolean, track_stock),
      active           = coalesce((p->>'active')::boolean, active),
      reorder_point    = case when p ? 'reorder_point' then inv._jnum(p, 'reorder_point') else reorder_point end,
      reorder_qty      = case when p ? 'reorder_qty' then inv._jnum(p, 'reorder_qty') else reorder_qty end,
      attributes       = case when p ? 'attributes' then coalesce(p->'attributes', '{}') else attributes end,
      synced_at        = now()
    where id = v_id
    returning * into r;
  end if;
  return to_jsonb(r);
exception when unique_violation then
  perform inv._raise('DUPLICATE_REF', format('sku %s already belongs to another Woo product', v_sku),
    jsonb_build_object('sku', v_sku));
end $$;

-- ---------------------------------------------------------------------------
-- Rå bevegelse (spec §5.2)
-- ---------------------------------------------------------------------------
create or replace function inv.post_movement(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_item   uuid := inv._resolve_item(inv._jtext(p, 'sku'));
  v_loc    uuid := inv._resolve_location(inv._jtext(p, 'location'));
  v_type   inv.movement_type;
  v_qty    numeric := inv._jnum(p, 'qty');
  v_ref_type text := inv._jtext(p, 'ref_type');
  v_ref_id   text := inv._jtext(p, 'ref_id');
  v_ref_line text := inv._jtext(p, 'ref_line');
  v_existing bigint;
  v_cost   record;
  v_id     bigint;
  v_allow  boolean;
begin
  begin
    v_type := (p->>'type')::inv.movement_type;
  exception when others then
    perform inv._raise('VALIDATION', format('invalid type %s', p->>'type'));
  end;
  if v_type = 'reversal' then
    perform inv._raise('VALIDATION', 'use reverse_movement() to reverse');
  end if;
  if v_qty is null or v_qty = 0 then perform inv._raise('VALIDATION', 'qty must be non-zero'); end if;

  v_existing := inv._existing_ref(v_ref_type, v_ref_id, v_ref_line);
  if v_existing is not null then
    if coalesce(p->>'on_conflict', 'return_existing') = 'error' then
      perform inv._raise('DUPLICATE_REF', 'movement with this ref already exists',
        jsonb_build_object('movement_id', v_existing));
    end if;
    return inv._movement_json(v_existing) || jsonb_build_object('existing', true);
  end if;

  if v_type in ('opening_balance','purchase_receipt','sale_return','adjustment_in','transfer_in') then
    if v_qty < 0 then perform inv._raise('VALIDATION', format('%s requires qty > 0', v_type)); end if;
    select * into v_cost from inv._resolve_in_cost(v_item, v_loc, inv._jnum(p, 'unit_cost'));
    v_id := inv._post_in(v_item, v_loc, v_type,
      jsonb_build_array(jsonb_build_object('qty', v_qty, 'unit_cost', v_cost.unit_cost,
                                           'received_at', inv._jts(p, 'occurred_at'))),
      coalesce(inv._jtext(p, 'cost_source'), v_cost.cost_source),
      v_ref_type, v_ref_id, v_ref_line, inv._jtext(p, 'reference'), inv._jtext(p, 'note'),
      inv._jtext(p, 'by'), inv._jts(p, 'occurred_at'), p->'metadata');
  else
    if v_qty > 0 then perform inv._raise('VALIDATION', format('%s requires qty < 0', v_type)); end if;
    v_allow := coalesce((p->>'allow_negative')::boolean,
                        v_type = 'sale' and inv._setting_bool('allow_negative_sale'));
    v_id := inv._post_out(v_item, v_loc, v_type, abs(v_qty), v_allow,
      v_ref_type, v_ref_id, v_ref_line, inv._jtext(p, 'reference'), inv._jtext(p, 'note'),
      inv._jtext(p, 'by'), inv._jts(p, 'occurred_at'), p->'metadata');
  end if;
  return inv._movement_json(v_id) || jsonb_build_object('existing', false);
end $$;

-- ---------------------------------------------------------------------------
-- Justering (spec §3.3, §5.4)
-- ---------------------------------------------------------------------------
create or replace function inv._adjustment_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(a) - 'location_id'
         || jsonb_build_object('location', l.code,
              'lines', coalesce((
                select jsonb_agg(to_jsonb(al) - 'item_id' || jsonb_build_object('sku', i.sku, 'item_name', i.name)
                                 order by al.position)
                from inv.adjustment_line al join inv.item i on i.id = al.item_id
                where al.adjustment_id = a.id), '[]'::jsonb),
              'movements', coalesce((
                select jsonb_agg(inv._movement_json(mid) order by mid)
                from (select movement_id as mid from inv.adjustment_line where adjustment_id = a.id and movement_id is not null
                      union all
                      select revalue_out_movement_id from inv.adjustment_line where adjustment_id = a.id and revalue_out_movement_id is not null) x
              ), '[]'::jsonb))
  from inv.adjustment a join inv.location l on l.id = a.location_id
  where a.id = p_id
$$;

-- Felles logikk for create_adjustment og preview. p_commit=false skriver ingenting
-- (kjøres i en savepoint som rulles tilbake av preview-wrapperen).
create or replace function inv.create_adjustment(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_loc     uuid := inv._resolve_location(inv._jtext(p, 'location'));
  v_reason  text := inv._jtext(p, 'reason');
  v_by      text := inv._jtext(p, 'by');
  v_at      timestamptz := coalesce(inv._jts(p, 'occurred_at'), now());
  v_wo      boolean := coalesce((p->>'write_off')::boolean, false);
  v_adj     uuid;
  v_number  text;
  e         jsonb;
  v_pos     int := 0;
  v_item    uuid;
  b         inv.stock_balance;
  v_delta   numeric;
  v_newq    numeric;
  v_reval   numeric;
  v_cost    record;
  v_mid     bigint;
  v_out_mid bigint;
  v_line    uuid;
begin
  if v_reason is null then perform inv._raise('VALIDATION', 'reason is required'); end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;

  v_number := 'ADJ-' || lpad(nextval('inv.adj_number_seq')::text, 6, '0');
  insert into inv.adjustment (number, location_id, reason, note, write_off, created_by, occurred_at)
  values (v_number, v_loc, v_reason, inv._jtext(p, 'note'), v_wo, v_by, v_at)
  returning id into v_adj;

  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos  := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_delta := inv._jnum(e, 'delta');
    v_newq  := inv._jnum(e, 'new_qty');
    v_reval := inv._jnum(e, 'revalue_to_unit_cost');
    v_mid := null; v_out_mid := null;

    if v_reval is not null then
      if v_delta is not null or v_newq is not null then
        perform inv._raise('VALIDATION', 'revalue_to_unit_cost cannot be combined with delta/new_qty',
          jsonb_build_object('line', v_pos));
      end if;
    elsif (v_delta is null) = (v_newq is null) then
      perform inv._raise('VALIDATION', 'each line needs exactly one of delta or new_qty',
        jsonb_build_object('line', v_pos));
    end if;
    if v_newq is not null and v_newq < 0 then
      perform inv._raise('VALIDATION', 'new_qty cannot be negative', jsonb_build_object('line', v_pos));
    end if;

    b := inv._lock_balance(v_item, v_loc);   -- låst FØR delta beregnes (T18)

    insert into inv.adjustment_line (adjustment_id, position, item_id, qty_before, qty_delta, qty_after, note)
    values (v_adj, v_pos, v_item, b.on_hand, 0, b.on_hand, inv._jtext(e, 'note'))
    returning id into v_line;

    if v_reval is not null then
      -- Revaluering: ut alt til FIFO-kost, inn igjen med ny kost (spec §3.3)
      if b.on_hand <= 0 then
        perform inv._raise('VALIDATION', 'cannot revalue an item with no stock on this location',
          jsonb_build_object('line', v_pos, 'sku', inv._sku(v_item)));
      end if;
      if v_reval < 0 then perform inv._raise('VALIDATION', 'revalue_to_unit_cost cannot be negative'); end if;
      v_out_mid := inv._post_out(v_item, v_loc, 'adjustment_out', b.on_hand, false,
        'adjustment', v_adj::text, v_line::text || ':revalue_out', v_number, 'Revaluering', v_by, v_at, null);
      v_mid := inv._post_in(v_item, v_loc, 'adjustment_in',
        jsonb_build_array(jsonb_build_object('qty', b.on_hand, 'unit_cost', v_reval, 'received_at', v_at)),
        'manual', 'adjustment', v_adj::text, v_line::text || ':revalue_in', v_number, 'Revaluering', v_by, v_at, null);
      update inv.adjustment_line
         set unit_cost = v_reval, cost_source = 'manual', movement_id = v_mid, revalue_out_movement_id = v_out_mid
       where id = v_line;
      continue;
    end if;

    if v_newq is not null then v_delta := v_newq - b.on_hand; end if;

    if v_delta > 0 then
      if v_wo then
        perform inv._raise('VALIDATION', 'write_off adjustments can only reduce stock', jsonb_build_object('line', v_pos));
      end if;
      select * into v_cost from inv._resolve_in_cost(v_item, v_loc, inv._jnum(e, 'unit_cost'));
      v_mid := inv._post_in(v_item, v_loc, 'adjustment_in',
        jsonb_build_array(jsonb_build_object('qty', v_delta, 'unit_cost', v_cost.unit_cost, 'received_at', v_at)),
        v_cost.cost_source, 'adjustment', v_adj::text, v_line::text, v_number,
        coalesce(inv._jtext(e, 'note'), v_reason), v_by, v_at, null);
      update inv.adjustment_line
         set qty_delta = v_delta, qty_after = b.on_hand + v_delta,
             unit_cost = v_cost.unit_cost, cost_source = v_cost.cost_source, movement_id = v_mid
       where id = v_line;
    elsif v_delta < 0 then
      v_mid := inv._post_out(v_item, v_loc, case when v_wo then 'write_off' else 'adjustment_out' end::inv.movement_type,
        -v_delta, false, 'adjustment', v_adj::text, v_line::text, v_number,
        coalesce(inv._jtext(e, 'note'), v_reason), v_by, v_at, null);
      update inv.adjustment_line l
         set qty_delta = v_delta, qty_after = b.on_hand + v_delta,
             unit_cost = m.unit_cost, cost_source = 'fifo', movement_id = v_mid
        from inv.movement m where m.id = v_mid and l.id = v_line;
    end if;
    -- delta = 0: linjen står med movement_id null
  end loop;

  return inv._adjustment_json(v_adj);
end $$;

-- Forhåndsvisning: kjør create_adjustment og rull tilbake (sekvenser brukes, men ingenting lagres).
create or replace function inv.preview_adjustment(p jsonb) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := inv.create_adjustment(p);
    raise exception 'INV_PREVIEW_ROLLBACK' using errcode = 'IVPRV';
  exception when sqlstate 'IVPRV' then
    null; -- rullet tilbake, v beholdes
  end;
  return v || jsonb_build_object('preview', true);
end $$;

-- ---------------------------------------------------------------------------
-- Overføring (spec §3.6)
-- ---------------------------------------------------------------------------
create or replace function inv._transfer_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(t) - 'from_location_id' - 'to_location_id'
         || jsonb_build_object('from_location', lf.code, 'to_location', lt.code,
              'lines', coalesce((
                select jsonb_agg(to_jsonb(tl) - 'item_id' || jsonb_build_object('sku', i.sku) order by tl.position)
                from inv.transfer_line tl join inv.item i on i.id = tl.item_id
                where tl.transfer_id = t.id), '[]'::jsonb))
  from inv.transfer t
  join inv.location lf on lf.id = t.from_location_id
  join inv.location lt on lt.id = t.to_location_id
  where t.id = p_id
$$;

create or replace function inv.create_transfer(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_from  uuid := inv._resolve_location(inv._jtext(p, 'from_location'));
  v_to    uuid := inv._resolve_location(inv._jtext(p, 'to_location'));
  v_by    text := inv._jtext(p, 'by');
  v_at    timestamptz := coalesce(inv._jts(p, 'occurred_at'), now());
  v_tr    uuid;
  v_number text;
  e       jsonb;
  v_pos   int := 0;
  v_item  uuid;
  v_qty   numeric;
  v_line  uuid;
  v_out   bigint;
  v_in    bigint;
  v_layers jsonb;
begin
  if inv._jtext(p, 'from_location') is null or inv._jtext(p, 'to_location') is null then
    perform inv._raise('VALIDATION', 'from_location and to_location are required');
  end if;
  if v_from = v_to then perform inv._raise('VALIDATION', 'from_location and to_location must differ'); end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;

  v_number := 'TR-' || lpad(nextval('inv.tr_number_seq')::text, 6, '0');
  insert into inv.transfer (number, from_location_id, to_location_id, note, created_by, occurred_at)
  values (v_number, v_from, v_to, inv._jtext(p, 'note'), v_by, v_at)
  returning id into v_tr;

  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos  := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_qty  := inv._jnum(e, 'qty');
    if v_qty is null or v_qty <= 0 then
      perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos));
    end if;

    -- Lås begge saldoer i fast rekkefølge for å unngå deadlock
    if v_from < v_to then
      perform inv._lock_balance(v_item, v_from); perform inv._lock_balance(v_item, v_to);
    else
      perform inv._lock_balance(v_item, v_to); perform inv._lock_balance(v_item, v_from);
    end if;

    insert into inv.transfer_line (transfer_id, position, item_id, qty)
    values (v_tr, v_pos, v_item, v_qty) returning id into v_line;

    v_out := inv._post_out(v_item, v_from, 'transfer_out', v_qty, false,
      'transfer', v_tr::text, v_line::text || ':out', v_number, inv._jtext(p, 'note'), v_by, v_at, null);

    -- Hvert konsumerte lag gjenskapes på mottakssiden med samme kost og received_at
    select jsonb_agg(jsonb_build_object('qty', c.qty, 'unit_cost', c.unit_cost,
                                        'received_at', cl.received_at, 'source_layer_id', cl.id) order by c.id)
      into v_layers
      from inv.layer_consumption c join inv.cost_layer cl on cl.id = c.layer_id
     where c.movement_id = v_out;

    v_in := inv._post_in(v_item, v_to, 'transfer_in', v_layers, 'transfer',
      'transfer', v_tr::text, v_line::text || ':in', v_number, inv._jtext(p, 'note'), v_by, v_at,
      jsonb_build_object('layers', v_layers));

    update inv.transfer_line set out_movement_id = v_out, in_movement_id = v_in where id = v_line;
  end loop;

  return inv._transfer_json(v_tr);
end $$;

-- ---------------------------------------------------------------------------
-- Innkjøp (spec §5.3)
-- ---------------------------------------------------------------------------
create or replace function inv._po_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(po) - 'location_id'
         || jsonb_build_object(
              'location', l.code,
              'lines', coalesce((
                select jsonb_agg(to_jsonb(pl) - 'item_id'
                                 || jsonb_build_object('item_name', i.name,
                                                       'qty_open', greatest(pl.qty_ordered - pl.qty_received, 0))
                                 order by pl.position)
                from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                where pl.po_id = po.id), '[]'::jsonb),
              'receipts', coalesce((
                select jsonb_agg(jsonb_build_object('id', gr.id, 'number', gr.number, 'status', gr.status,
                                                    'received_at', gr.received_at, 'received_by', gr.received_by)
                                 order by gr.created_at)
                from inv.goods_receipt gr where gr.po_id = po.id), '[]'::jsonb),
              'totals', (select jsonb_build_object(
                            'qty_ordered', coalesce(sum(qty_ordered), 0),
                            'qty_received', coalesce(sum(qty_received), 0),
                            'amount', coalesce(round(sum(qty_ordered * unit_cost), 2), 0))
                         from inv.purchase_order_line where po_id = po.id))
  from inv.purchase_order po left join inv.location l on l.id = po.location_id
  where po.id = p_id
$$;

create or replace function inv._po_replace_lines(p_po uuid, p_lines jsonb) returns void
language plpgsql as $$
declare
  e jsonb; v_pos int := 0; v_item uuid; v_qty numeric; v_cost numeric;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  delete from inv.purchase_order_line where po_id = p_po;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_pos := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_qty  := inv._jnum(e, 'qty');
    v_cost := inv._jnum(e, 'unit_cost');
    if v_qty is null or v_qty <= 0 then
      perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos));
    end if;
    if v_cost is null or v_cost < 0 then
      perform inv._raise('VALIDATION', 'unit_cost is required and must be >= 0', jsonb_build_object('line', v_pos));
    end if;
    begin
      insert into inv.purchase_order_line (po_id, position, item_id, sku, qty_ordered, unit_cost, landed_cost_per_unit, note)
      values (p_po, v_pos, v_item, inv._sku(v_item), v_qty, v_cost,
              coalesce(inv._jnum(e, 'landed_cost_per_unit'), 0), inv._jtext(e, 'note'));
    exception when unique_violation then
      perform inv._raise('VALIDATION', format('sku %s appears more than once', inv._sku(v_item)),
        jsonb_build_object('line', v_pos));
    end;
  end loop;
end $$;

create or replace function inv.create_purchase_order(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_base  text := inv._setting('base_currency');
  v_cur   text := upper(coalesce(inv._jtext(p, 'currency'), v_base));
  v_fx    numeric := inv._jnum(p, 'fx_rate');
  v_id    uuid;
begin
  if inv._jtext(p, 'supplier_name') is null then perform inv._raise('VALIDATION', 'supplier_name is required'); end if;
  if v_cur = v_base then v_fx := coalesce(v_fx, 1); end if;
  if v_fx is not null and v_fx <= 0 then perform inv._raise('VALIDATION', 'fx_rate must be > 0'); end if;

  insert into inv.purchase_order (number, supplier_name, supplier_id, supplier_ref, currency, fx_rate,
                                  location_id, order_date, expected_at, note, created_by, metadata)
  values (inv._setting('po_number_prefix') || lpad(nextval('inv.po_number_seq')::text, 5, '0'),
          inv._jtext(p, 'supplier_name'), inv._jtext(p, 'supplier_id'), inv._jtext(p, 'supplier_ref'),
          v_cur, v_fx, inv._resolve_location(inv._jtext(p, 'location')),
          coalesce((inv._jtext(p, 'order_date'))::date, current_date), (inv._jtext(p, 'expected_at'))::date,
          inv._jtext(p, 'note'), inv._jtext(p, 'by'), coalesce(p->'metadata', '{}'))
  returning id into v_id;

  perform inv._po_replace_lines(v_id, p->'lines');
  return inv._po_json(v_id);
end $$;

create or replace function inv._lock_po(p_id uuid) returns inv.purchase_order
language plpgsql as $$
declare po inv.purchase_order;
begin
  select * into po from inv.purchase_order where id = p_id for update;
  if po.id is null then
    perform inv._raise('PO_NOT_FOUND', format('purchase order %s not found', p_id), jsonb_build_object('po_id', p_id));
  end if;
  return po;
end $$;

create or replace function inv.update_purchase_order(p_po_id uuid, p jsonb) returns jsonb
language plpgsql as $$
declare
  po inv.purchase_order := inv._lock_po(p_po_id);
  v_has_receipts boolean;
  v_base text := inv._setting('base_currency');
  v_cur  text;
begin
  if po.status in ('closed','cancelled','received') then
    perform inv._raise('PO_LOCKED', format('purchase order is %s', po.status), jsonb_build_object('status', po.status));
  end if;
  select exists (select 1 from inv.goods_receipt where po_id = po.id and status = 'completed') into v_has_receipts;

  if (p ? 'currency' or p ? 'fx_rate') and v_has_receipts then
    perform inv._raise('PO_LOCKED', 'currency/fx_rate cannot change after a receipt');
  end if;
  v_cur := upper(coalesce(inv._jtext(p, 'currency'), po.currency));

  update inv.purchase_order set
    supplier_name = coalesce(inv._jtext(p, 'supplier_name'), supplier_name),
    supplier_id   = case when p ? 'supplier_id' then inv._jtext(p, 'supplier_id') else supplier_id end,
    supplier_ref  = case when p ? 'supplier_ref' then inv._jtext(p, 'supplier_ref') else supplier_ref end,
    currency      = v_cur,
    fx_rate       = case when p ? 'fx_rate' then inv._jnum(p, 'fx_rate')
                         when v_cur = v_base then coalesce(fx_rate, 1) else fx_rate end,
    location_id   = case when p ? 'location' then inv._resolve_location(inv._jtext(p, 'location')) else location_id end,
    order_date    = case when p ? 'order_date' then (inv._jtext(p, 'order_date'))::date else order_date end,
    expected_at   = case when p ? 'expected_at' then (inv._jtext(p, 'expected_at'))::date else expected_at end,
    note          = case when p ? 'note' then inv._jtext(p, 'note') else note end,
    metadata      = case when p ? 'metadata' then metadata || coalesce(p->'metadata', '{}') else metadata end
  where id = po.id;

  if p ? 'lines' then
    if v_has_receipts then
      perform inv._raise('PO_LOCKED', 'lines cannot be replaced after a receipt — receive or close instead');
    end if;
    if po.status = 'sent' then
      update inv.purchase_order
         set metadata = jsonb_set(metadata, '{history}',
               coalesce(metadata->'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                 'at', now(), 'by', inv._jtext(p, 'by'),
                 'lines_before', (select jsonb_agg(jsonb_build_object('sku', sku, 'qty', qty_ordered, 'unit_cost', unit_cost))
                                  from inv.purchase_order_line where po_id = po.id))))
       where id = po.id;
    end if;
    perform inv._po_replace_lines(po.id, p->'lines');
  end if;
  return inv._po_json(po.id);
end $$;

create or replace function inv.set_purchase_order_status(p_po_id uuid, p_status text, p_by text default null) returns jsonb
language plpgsql as $$
declare
  po inv.purchase_order := inv._lock_po(p_po_id);
  v_new inv.po_status;
  v_has_receipts boolean;
begin
  begin v_new := p_status::inv.po_status;
  exception when others then perform inv._raise('VALIDATION', format('invalid status %s', p_status)); end;
  select exists (select 1 from inv.goods_receipt where po_id = po.id and status = 'completed') into v_has_receipts;

  if not (
       (po.status = 'draft' and v_new in ('sent','cancelled'))
    or (po.status = 'sent' and v_new = 'cancelled' and not v_has_receipts)
    or (po.status = 'sent' and v_new = 'draft' and not v_has_receipts)
    or (po.status in ('partially_received','received') and v_new = 'closed')
  ) then
    perform inv._raise('PO_STATUS_INVALID', format('cannot change status from %s to %s', po.status, v_new),
      jsonb_build_object('from', po.status, 'to', v_new));
  end if;

  update inv.purchase_order set
    status = v_new,
    sent_at = case when v_new = 'sent' then now() else sent_at end,
    cancelled_at = case when v_new = 'cancelled' then now() else cancelled_at end,
    closed_at = case when v_new = 'closed' then now() else closed_at end,
    metadata = metadata || jsonb_build_object('status_changed_by', p_by)
  where id = po.id;
  return inv._po_json(po.id);
end $$;

create or replace function inv._po_recompute_status(p_po uuid) returns void
language plpgsql as $$
declare v_all boolean; v_any boolean;
begin
  select bool_and(qty_received >= qty_ordered), bool_or(qty_received > 0)
    into v_all, v_any from inv.purchase_order_line where po_id = p_po;
  update inv.purchase_order set
    status = case when v_all then 'received' when v_any then 'partially_received' else 'sent' end::inv.po_status,
    received_at = case when v_all then coalesce(received_at, now()) else null end
  where id = p_po and status in ('sent','partially_received','received');
end $$;

create or replace function inv._receipt_json(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(gr) - 'location_id'
         || jsonb_build_object('location', l.code, 'po_number', po.number,
              'lines', coalesce((
                 select jsonb_agg(to_jsonb(grl) - 'item_id' || jsonb_build_object('sku', i.sku) order by grl.created_at, grl.id)
                 from inv.goods_receipt_line grl join inv.item i on i.id = grl.item_id
                 where grl.receipt_id = gr.id), '[]'::jsonb),
              'movements', coalesce((
                 select jsonb_agg(inv._movement_json(grl.movement_id) order by grl.movement_id)
                 from inv.goods_receipt_line grl where grl.receipt_id = gr.id and grl.movement_id is not null), '[]'::jsonb))
  from inv.goods_receipt gr
  join inv.location l on l.id = gr.location_id
  join inv.purchase_order po on po.id = gr.po_id
  where gr.id = p_id
$$;

create or replace function inv.receive_purchase_order(p_po_id uuid, p jsonb) returns jsonb
language plpgsql as $$
declare
  po      inv.purchase_order := inv._lock_po(p_po_id);
  v_loc   uuid;
  v_at    timestamptz := coalesce(inv._jts(p, 'received_at'), now());
  v_fx    numeric;
  v_by    text := inv._jtext(p, 'by');
  v_over  boolean := coalesce((p->>'allow_over_receipt')::boolean, false);
  v_gr    uuid;
  v_grnum text;
  e       jsonb;
  pl      inv.purchase_order_line;
  v_qty   numeric;
  v_uc    numeric;
  v_land  numeric;
  v_base_cost numeric;
  v_grl   uuid;
  v_mid   bigint;
  v_pos   int := 0;
begin
  if po.status not in ('sent','partially_received') then
    perform inv._raise('PO_STATUS_INVALID', format('cannot receive a %s purchase order', po.status),
      jsonb_build_object('status', po.status));
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  v_fx := coalesce(inv._jnum(p, 'fx_rate'), po.fx_rate);
  if v_fx is null then
    perform inv._raise('VALIDATION', format('fx_rate is required for %s', po.currency));
  end if;
  if v_fx <= 0 then perform inv._raise('VALIDATION', 'fx_rate must be > 0'); end if;
  v_loc := case when inv._jtext(p, 'location') is not null then inv._resolve_location(inv._jtext(p, 'location'))
                else coalesce(po.location_id, inv._resolve_location(null)) end;

  v_grnum := 'GR-' || lpad(nextval('inv.gr_number_seq')::text, 6, '0');
  insert into inv.goods_receipt (number, po_id, location_id, received_at, received_by, fx_rate, note)
  values (v_grnum, po.id, v_loc, v_at, v_by, v_fx, inv._jtext(p, 'note'))
  returning id into v_gr;

  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos := v_pos + 1;
    pl := null;
    if inv._jtext(e, 'po_line_id') is not null then
      select * into pl from inv.purchase_order_line where id = (e->>'po_line_id')::uuid and po_id = po.id for update;
    elsif inv._jtext(e, 'sku') is not null then
      select * into pl from inv.purchase_order_line
       where po_id = po.id and item_id = inv._resolve_item(inv._jtext(e, 'sku')) for update;
    end if;
    if pl.id is null then
      perform inv._raise('VALIDATION', 'line is not on this purchase order',
        jsonb_build_object('line', v_pos, 'sku', e->>'sku', 'po_line_id', e->>'po_line_id'));
    end if;

    v_qty := inv._jnum(e, 'qty');
    if v_qty is null or v_qty <= 0 then
      perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos));
    end if;
    if not v_over and pl.qty_received + v_qty > pl.qty_ordered then
      perform inv._raise('OVER_RECEIPT',
        format('%s: ordered %s, already received %s, cannot receive %s', pl.sku, pl.qty_ordered, pl.qty_received, v_qty),
        jsonb_build_object('sku', pl.sku, 'qty_ordered', pl.qty_ordered, 'qty_received', pl.qty_received, 'qty', v_qty));
    end if;

    v_uc   := coalesce(inv._jnum(e, 'unit_cost'), pl.unit_cost);
    v_land := coalesce(inv._jnum(e, 'landed_cost_per_unit'), pl.landed_cost_per_unit, 0);
    if v_uc < 0 or v_land < 0 then perform inv._raise('VALIDATION', 'costs must be >= 0'); end if;
    v_base_cost := round(v_uc * v_fx + v_land, 4);

    insert into inv.goods_receipt_line (receipt_id, po_line_id, item_id, qty, unit_cost, landed_cost_per_unit, unit_cost_base, note)
    values (v_gr, pl.id, pl.item_id, v_qty, v_uc, v_land, v_base_cost, inv._jtext(e, 'note'))
    returning id into v_grl;

    v_mid := inv._post_in(pl.item_id, v_loc, 'purchase_receipt',
      jsonb_build_array(jsonb_build_object('qty', v_qty, 'unit_cost', v_base_cost, 'received_at', v_at)),
      'po_line', 'goods_receipt', v_gr::text, v_grl::text, po.number,
      inv._jtext(e, 'note'), v_by, v_at,
      jsonb_build_object('po_id', po.id, 'po_line_id', pl.id, 'currency', po.currency,
                         'unit_cost_po_currency', v_uc, 'fx_rate', v_fx, 'landed_cost_per_unit', v_land));

    update inv.goods_receipt_line set movement_id = v_mid where id = v_grl;
    update inv.purchase_order_line set qty_received = qty_received + v_qty where id = pl.id;
  end loop;

  perform inv._po_recompute_status(po.id);
  return inv._receipt_json(v_gr) || jsonb_build_object('purchase_order', inv._po_json(po.id));
end $$;

-- ---------------------------------------------------------------------------
-- Salg og retur utenom Woo (spec §5.4)
-- ---------------------------------------------------------------------------
create or replace function inv.record_sale(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_ref_type text := coalesce(inv._jtext(p, 'ref_type'), 'manual_sale');
  v_ref_id   text := inv._jtext(p, 'ref_id');
  v_loc      uuid := inv._resolve_location(inv._jtext(p, 'location'));
  v_allow    boolean := inv._setting_bool('allow_negative_sale');
  e jsonb; v_pos int := 0; v_item uuid; v_qty numeric; v_line text; v_mid bigint;
  v_out jsonb := '[]';
begin
  if v_ref_id is null then perform inv._raise('VALIDATION', 'ref_id is required'); end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_qty := inv._jnum(e, 'qty');
    if v_qty is null or v_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos)); end if;
    v_line := coalesce(inv._jtext(e, 'ref_line'), v_pos::text);
    v_mid := inv._existing_ref(v_ref_type, v_ref_id, v_line);
    if v_mid is null then
      v_mid := inv._post_out(v_item, v_loc, 'sale', v_qty, v_allow, v_ref_type, v_ref_id, v_line,
        coalesce(inv._jtext(p, 'reference'), v_ref_id), inv._jtext(p, 'note'), inv._jtext(p, 'by'),
        inv._jts(p, 'occurred_at'), p->'metadata');
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', false));
    else
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', true));
    end if;
  end loop;
  return jsonb_build_object('movements', v_out);
end $$;

-- Vektet COGS for en vare på et gitt salg (alle linjer) — brukes som returkost (spec §3.8).
create or replace function inv._sale_unit_cost(p_item uuid, p_ref_type text, p_ref_id text, p_ref_line text default null)
returns numeric language sql stable as $$
  select round(sum(total_cost) / nullif(sum(abs(qty)), 0), 4)
  from inv.movement
  where item_id = p_item and type = 'sale' and ref_type = p_ref_type and ref_id = p_ref_id
    and (p_ref_line is null or ref_line = p_ref_line or ref_line like p_ref_line || ':%')
$$;

create or replace function inv.record_sale_return(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_ref_type text := coalesce(inv._jtext(p, 'ref_type'), 'manual_return');
  v_ref_id   text := inv._jtext(p, 'ref_id');
  v_orig_type text := coalesce(inv._jtext(p, 'original_ref_type'), 'manual_sale');
  v_orig_id   text := inv._jtext(p, 'original_ref_id');
  v_loc      uuid := inv._resolve_location(inv._jtext(p, 'location'));
  e jsonb; v_pos int := 0; v_item uuid; v_qty numeric; v_line text; v_mid bigint;
  v_uc numeric; v_src text; v_cost record;
  v_out jsonb := '[]';
begin
  if v_ref_id is null then perform inv._raise('VALIDATION', 'ref_id is required'); end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  for e in select * from jsonb_array_elements(p->'lines') loop
    v_pos := v_pos + 1;
    v_item := inv._resolve_item(inv._jtext(e, 'sku'));
    v_qty := inv._jnum(e, 'qty');
    if v_qty is null or v_qty <= 0 then perform inv._raise('VALIDATION', 'qty must be > 0', jsonb_build_object('line', v_pos)); end if;
    v_line := coalesce(inv._jtext(e, 'ref_line'), v_pos::text);
    v_mid := inv._existing_ref(v_ref_type, v_ref_id, v_line);
    if v_mid is null then
      v_uc := inv._jnum(e, 'unit_cost'); v_src := 'manual';
      if v_uc is null and v_orig_id is not null then
        v_uc := inv._sale_unit_cost(v_item, v_orig_type, v_orig_id, inv._jtext(e, 'original_ref_line'));
        v_src := 'sale_cogs';
      end if;
      if v_uc is null then
        select * into v_cost from inv._resolve_in_cost(v_item, v_loc, null);
        v_uc := v_cost.unit_cost; v_src := v_cost.cost_source;
      end if;
      v_mid := inv._post_in(v_item, v_loc, 'sale_return',
        jsonb_build_array(jsonb_build_object('qty', v_qty, 'unit_cost', v_uc)), v_src,
        v_ref_type, v_ref_id, v_line, coalesce(inv._jtext(p, 'reference'), v_ref_id),
        inv._jtext(p, 'note'), inv._jtext(p, 'by'), inv._jts(p, 'occurred_at'), p->'metadata');
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', false));
    else
      v_out := v_out || (inv._movement_json(v_mid) || jsonb_build_object('existing', true));
    end if;
  end loop;
  return jsonb_build_object('movements', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- Reversering (spec §3.7)
-- ---------------------------------------------------------------------------
create or replace function inv._reverse(p_id bigint, p_by text, p_note text) returns bigint
language plpgsql as $$
declare
  m       inv.movement;
  v_rid   bigint;
  v_layers jsonb;
  v_open_qty numeric;
  v_open_cost numeric;
  c record;
begin
  select * into m from inv.movement where id = p_id for update;
  if m.id is null then perform inv._raise('NOT_FOUND', format('movement %s not found', p_id)); end if;
  if m.reversed_by is not null then
    perform inv._raise('ALREADY_REVERSED', format('movement %s is already reversed', p_id),
      jsonb_build_object('reversed_by', m.reversed_by));
  end if;
  if m.type = 'reversal' then
    perform inv._raise('VALIDATION', 'a reversal cannot be reversed — post a new movement instead');
  end if;

  if m.qty > 0 then
    -- Inngang: ta ut nøyaktig lagene denne bevegelsen skapte (må være urørte)
    if exists (select 1 from inv.cost_layer where movement_id = m.id and qty_remaining < qty_in) then
      perform inv._raise('LAYER_CONSUMED',
        'stock from this movement has already been sold or moved — post an adjustment instead',
        jsonb_build_object('movement_id', m.id));
    end if;
    v_rid := inv._post_out(m.item_id, m.location_id, 'reversal', m.qty, true,
      'reversal', m.id::text, null, m.reference, p_note, p_by, now(),
      jsonb_build_object('reversal_of_type', m.type), m.id, m.id);
  else
    perform inv._lock_balance(m.item_id, m.location_id);
    -- Utgang: dekket konsum gir lagene tilbake (samme kost og received_at);
    -- udekket konsum gjenopprettes ikke som lag — det lukkes, og beholdningen
    -- nøytraliseres med tilsvarende antall uten lag.
    select coalesce(sum(qty), 0), coalesce(sum(qty * unit_cost), 0) into v_open_qty, v_open_cost
      from inv.layer_consumption where movement_id = m.id and layer_id is null and covered_by_movement_id is null;

    select jsonb_agg(jsonb_build_object('qty', c2.qty, 'unit_cost', c2.unit_cost,
                                        'received_at', cl.received_at, 'source_layer_id', cl.id) order by c2.id)
      into v_layers
      from inv.layer_consumption c2 join inv.cost_layer cl on cl.id = c2.layer_id
     where c2.movement_id = m.id;

    -- Lukk eget udekket konsum FØR lagene legges inn, så det ikke dekkes av
    -- sine egne gjenopprettede lag. Original-id brukes midlertidig som markør.
    if v_open_qty > 0 then
      update inv.layer_consumption set covered_by_movement_id = m.id
       where movement_id = m.id and layer_id is null and covered_by_movement_id is null;
    end if;

    v_rid := inv._post_in(m.item_id, m.location_id, 'reversal', v_layers, 'reversal',
      'reversal', m.id::text, null, m.reference, p_note, p_by, now(),
      jsonb_build_object('reversal_of_type', m.type, 'uncovered_qty_closed', v_open_qty), m.id,
      v_open_qty, case when v_open_qty > 0 then v_open_cost / v_open_qty else 0 end);

    if v_open_qty > 0 then
      update inv.layer_consumption set covered_by_movement_id = v_rid
       where movement_id = m.id and layer_id is null and covered_by_movement_id = m.id;
    end if;
  end if;

  update inv.movement set reversed_by = v_rid where id = m.id;
  return v_rid;
end $$;

create or replace function inv.reverse_movement(p_movement_id bigint, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare v_id bigint;
begin
  -- Egen setning: _movement_json er STABLE og må se raden _reverse skrev.
  v_id := inv._reverse(p_movement_id, p_by, p_note);
  return inv._movement_json(v_id);
end $$;

create or replace function inv.reverse_adjustment(p_id uuid, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare a inv.adjustment; r record;
begin
  select * into a from inv.adjustment where id = p_id for update;
  if a.id is null then perform inv._raise('NOT_FOUND', 'adjustment not found'); end if;
  if a.status = 'reversed' then perform inv._raise('ALREADY_REVERSED', 'adjustment is already reversed'); end if;
  for r in
    select mid from (
      select movement_id as mid, position, 1 as ord from inv.adjustment_line where adjustment_id = a.id and movement_id is not null
      union all
      select revalue_out_movement_id, position, 2 from inv.adjustment_line where adjustment_id = a.id and revalue_out_movement_id is not null
    ) x order by position desc, ord
  loop
    perform inv._reverse(r.mid, p_by, coalesce(p_note, 'Reversering av ' || a.number));
  end loop;
  update inv.adjustment set status = 'reversed' where id = a.id;
  return inv._adjustment_json(a.id);
end $$;

create or replace function inv.reverse_goods_receipt(p_id uuid, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare gr inv.goods_receipt; po inv.purchase_order; r record;
begin
  select * into gr from inv.goods_receipt where id = p_id for update;
  if gr.id is null then perform inv._raise('NOT_FOUND', 'goods receipt not found'); end if;
  if gr.status = 'reversed' then perform inv._raise('ALREADY_REVERSED', 'goods receipt is already reversed'); end if;
  po := inv._lock_po(gr.po_id);
  if po.status in ('closed','cancelled') then
    perform inv._raise('PO_STATUS_INVALID', format('purchase order is %s', po.status));
  end if;
  for r in select * from inv.goods_receipt_line where receipt_id = gr.id order by created_at desc, id loop
    perform inv._reverse(r.movement_id, p_by, coalesce(p_note, 'Reversering av ' || gr.number));
    update inv.purchase_order_line set qty_received = qty_received - r.qty where id = r.po_line_id;
  end loop;
  update inv.goods_receipt set status = 'reversed' where id = gr.id;
  perform inv._po_recompute_status(po.id);
  return inv._receipt_json(gr.id);
end $$;

create or replace function inv.reverse_transfer(p_id uuid, p_by text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare t inv.transfer; r record;
begin
  select * into t from inv.transfer where id = p_id for update;
  if t.id is null then perform inv._raise('NOT_FOUND', 'transfer not found'); end if;
  if t.status = 'reversed' then perform inv._raise('ALREADY_REVERSED', 'transfer is already reversed'); end if;
  for r in select * from inv.transfer_line where transfer_id = t.id order by position desc loop
    perform inv._reverse(r.in_movement_id, p_by, coalesce(p_note, 'Reversering av ' || t.number));
    perform inv._reverse(r.out_movement_id, p_by, coalesce(p_note, 'Reversering av ' || t.number));
  end loop;
  update inv.transfer set status = 'reversed' where id = t.id;
  return inv._transfer_json(t.id);
end $$;

-- ---------------------------------------------------------------------------
-- Vedlikehold (spec §5.6)
-- ---------------------------------------------------------------------------
create or replace function inv.rebuild_balances() returns jsonb
language plpgsql as $$
declare n int;
begin
  insert into inv.stock_balance (item_id, location_id)
  select distinct item_id, location_id from inv.movement
  on conflict do nothing;
  update inv.stock_balance b set
    on_hand = coalesce((select sum(qty) from inv.movement m where m.item_id = b.item_id and m.location_id = b.location_id), 0),
    value   = inv._layer_value(b.item_id, b.location_id),
    updated_at = now();
  get diagnostics n = row_count;
  return jsonb_build_object('rows', n);
end $$;

create or replace function inv.verify_integrity() returns jsonb
language sql stable as $$
  with keys as (
    select item_id, location_id from inv.stock_balance
    union select item_id, location_id from inv.movement
  ),
  calc as (
    select k.item_id, k.location_id,
      coalesce(b.on_hand, 0) as on_hand,
      coalesce(b.value, 0) as value,
      coalesce((select sum(qty) from inv.movement m where m.item_id = k.item_id and m.location_id = k.location_id), 0) as mov_sum,
      coalesce((select sum(qty_remaining) from inv.cost_layer l where l.item_id = k.item_id and l.location_id = k.location_id), 0) as layer_qty,
      inv._layer_value(k.item_id, k.location_id) as layer_value,
      coalesce((select sum(c.qty) from inv.layer_consumption c join inv.movement m on m.id = c.movement_id
                where m.item_id = k.item_id and m.location_id = k.location_id
                  and c.layer_id is null and c.covered_by_movement_id is null), 0) as open_qty
    from keys k left join inv.stock_balance b on b.item_id = k.item_id and b.location_id = k.location_id
  ),
  issues as (
    select jsonb_build_object('sku', inv._sku(item_id), 'location', inv._loc_code(location_id),
             'on_hand', on_hand, 'movement_sum', mov_sum, 'layer_qty', layer_qty,
             'open_consumption', open_qty, 'value', value, 'layer_value', layer_value) as j
    from calc
    where on_hand <> mov_sum
       or layer_qty <> greatest(on_hand, 0)
       or open_qty <> greatest(-on_hand, 0)
       or value <> layer_value
  )
  select jsonb_build_object('ok', not exists (select 1 from issues),
                            'issues', coalesce((select jsonb_agg(j) from issues), '[]'::jsonb))
$$;

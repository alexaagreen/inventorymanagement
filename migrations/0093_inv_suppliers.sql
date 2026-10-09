-- inventory-ledger v0.7.0
-- =============================================================================
-- 0093_inv_suppliers.sql — suppliers and which suppliers each item is bought from
-- =============================================================================
-- * inv.supplier            the supplier register (one row per supplier)
-- * inv.item_supplier       many-to-many: an item can be bought from several suppliers,
--                           a supplier sells many items. At most ONE preferred supplier
--                           per item ("who we buy it from").
-- * purchase_order.supplier_uuid
--                           links a PO to the register. Resolved by trigger from
--                           supplier_id (when it is a register uuid) or supplier_name
--                           (case-insensitive match, created when missing), so existing
--                           callers that only send supplier_name keep working.
-- * Ordering an item from a supplier links them automatically (PO line trigger); the
--   first supplier linked to an item becomes its preferred supplier.
-- * Last purchase ("last bought from", "last price") is derived from completed goods
--   receipts — never stored — so reversing a receipt corrects it automatically.
--   Views: v_item_supplier (per item × supplier) and v_item_purchase_info (per item).
-- =============================================================================

create table if not exists inv.supplier (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (btrim(name) <> ''),
  code                   text unique,
  currency               text not null default 'NOK' check (currency ~ '^[A-Z]{3}$'),
  contact_name           text,
  email                  text,
  phone                  text,
  website                text,
  default_lead_time_days int check (default_lead_time_days is null or default_lead_time_days >= 0),
  note                   text,
  active                 boolean not null default true,
  metadata               jsonb not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_supplier_name on inv.supplier (lower(btrim(name)));
drop trigger if exists trg_supplier_updated on inv.supplier;
create trigger trg_supplier_updated before update on inv.supplier
  for each row execute function inv.set_updated_at();

create table if not exists inv.item_supplier (
  item_id         uuid not null references inv.item(id) on delete cascade,
  supplier_id     uuid not null references inv.supplier(id) on delete cascade,
  preferred       boolean not null default false,
  supplier_sku    text,
  list_price      numeric(14,4) check (list_price is null or list_price >= 0),
  list_currency   text check (list_currency is null or list_currency ~ '^[A-Z]{3}$'),
  lead_time_days  int check (lead_time_days is null or lead_time_days >= 0),
  min_order_qty   numeric(14,3) check (min_order_qty is null or min_order_qty > 0),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (item_id, supplier_id)
);
create unique index if not exists uq_item_supplier_preferred on inv.item_supplier (item_id) where preferred;
create index if not exists idx_item_supplier_supplier on inv.item_supplier (supplier_id);
drop trigger if exists trg_item_supplier_updated on inv.item_supplier;
create trigger trg_item_supplier_updated before update on inv.item_supplier
  for each row execute function inv.set_updated_at();

alter table inv.purchase_order add column if not exists supplier_uuid uuid references inv.supplier(id);
create index if not exists idx_po_supplier_uuid on inv.purchase_order (supplier_uuid);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function inv._is_uuid(p text) returns boolean
language sql immutable as $$
  select p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- Find a supplier by uuid, code or name (case-insensitive). Null when not found.
create or replace function inv._find_supplier(p_ref text) returns uuid
language sql stable as $$
  select s.id from inv.supplier s
   where (inv._is_uuid(p_ref) and s.id = p_ref::uuid)
      or s.code = p_ref
      or lower(btrim(s.name)) = lower(btrim(p_ref))
   order by (inv._is_uuid(p_ref) and s.id = p_ref::uuid) desc, (s.code = p_ref) desc
   limit 1
$$;

-- Find or create by name (used when a PO names a supplier that is not registered yet).
create or replace function inv._ensure_supplier(p_name text, p_currency text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  if p_name is null or btrim(p_name) = '' then return null; end if;
  v := inv._find_supplier(p_name);
  if v is null then
    insert into inv.supplier (name, currency)
    values (btrim(p_name), coalesce(nullif(upper(p_currency), ''), inv._setting('base_currency'), 'NOK'))
    on conflict ((lower(btrim(name)))) do nothing
    returning id into v;
    if v is null then v := inv._find_supplier(p_name); end if;
  end if;
  return v;
end $$;

create or replace function inv._resolve_supplier(p_ref text) returns uuid
language plpgsql stable as $$
declare v uuid;
begin
  if p_ref is null or btrim(p_ref) = '' then perform inv._raise('VALIDATION', 'supplier is required', '{"field":"supplier_id"}'); end if;
  v := inv._find_supplier(p_ref);
  if v is null then perform inv._raise('SUPPLIER_NOT_FOUND', format('supplier %s not found', p_ref), jsonb_build_object('supplier', p_ref)); end if;
  return v;
end $$;

-- Link item ↔ supplier if not linked yet; the first link of an item becomes preferred.
create or replace function inv._link_item_supplier(p_item uuid, p_supplier uuid) returns void
language plpgsql as $$
begin
  if p_item is null or p_supplier is null then return; end if;
  insert into inv.item_supplier (item_id, supplier_id, preferred)
  values (p_item, p_supplier, not exists (select 1 from inv.item_supplier x where x.item_id = p_item and x.preferred))
  on conflict (item_id, supplier_id) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Triggers: PO → supplier register, PO line → item_supplier link
-- ---------------------------------------------------------------------------
create or replace function inv._po_resolve_supplier() returns trigger
language plpgsql as $$
begin
  if new.supplier_uuid is null
     or (tg_op = 'UPDATE' and new.supplier_name is distinct from old.supplier_name and new.supplier_uuid = old.supplier_uuid)
     or (tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id and inv._is_uuid(new.supplier_id)) then
    if inv._is_uuid(new.supplier_id) and exists (select 1 from inv.supplier s where s.id = new.supplier_id::uuid) then
      new.supplier_uuid := new.supplier_id::uuid;
    else
      new.supplier_uuid := inv._ensure_supplier(new.supplier_name, new.currency);
    end if;
  end if;
  -- Keep the PO's display name in step with the register.
  if new.supplier_uuid is not null then
    select s.name into new.supplier_name from inv.supplier s where s.id = new.supplier_uuid;
  end if;
  return new;
end $$;
drop trigger if exists trg_po_resolve_supplier on inv.purchase_order;
create trigger trg_po_resolve_supplier before insert or update on inv.purchase_order
  for each row execute function inv._po_resolve_supplier();

create or replace function inv._pol_link_supplier() returns trigger
language plpgsql as $$
begin
  perform inv._link_item_supplier(new.item_id, (select po.supplier_uuid from inv.purchase_order po where po.id = new.po_id));
  return new;
end $$;
drop trigger if exists trg_pol_link_supplier on inv.purchase_order_line;
create trigger trg_pol_link_supplier after insert on inv.purchase_order_line
  for each row execute function inv._pol_link_supplier();

-- ---------------------------------------------------------------------------
-- Backfill: register suppliers from existing POs and link their items
-- ---------------------------------------------------------------------------
update inv.purchase_order set supplier_uuid = inv._ensure_supplier(supplier_name, currency)
 where supplier_uuid is null;
do $$
declare r record;
begin
  for r in select pl.item_id, po.supplier_uuid
             from inv.purchase_order_line pl join inv.purchase_order po on po.id = pl.po_id
            where po.supplier_uuid is not null
            order by po.created_at
  loop
    perform inv._link_item_supplier(r.item_id, r.supplier_uuid);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Every completed receipt line with its supplier (newest first per item).
create or replace view inv.v_purchase_history as
select grl.item_id, i.sku, po.supplier_uuid as supplier_id, po.supplier_name,
       gr.received_at, grl.qty, grl.unit_cost, po.currency, grl.unit_cost_base as unit_cost_nok,
       grl.landed_cost_per_unit, gr.fx_rate, po.id as po_id, po.number as po_number,
       gr.id as receipt_id, gr.number as receipt_number
  from inv.goods_receipt_line grl
  join inv.goods_receipt gr on gr.id = grl.receipt_id and gr.status = 'completed'
  join inv.purchase_order po on po.id = gr.po_id
  join inv.item i on i.id = grl.item_id;

create or replace view inv.v_item_supplier as
select x.item_id, i.sku, x.supplier_id, s.name as supplier_name, s.code as supplier_code, s.active as supplier_active,
       x.preferred, x.supplier_sku, x.list_price, coalesce(x.list_currency, s.currency) as list_currency,
       coalesce(x.lead_time_days, s.default_lead_time_days) as lead_time_days, x.min_order_qty, x.note,
       lp.received_at as last_purchase_at, lp.unit_cost as last_unit_cost, lp.currency as last_currency,
       lp.unit_cost_nok as last_unit_cost_nok, lp.qty as last_qty, lp.po_number as last_po_number,
       (select coalesce(sum(h.qty), 0) from inv.v_purchase_history h where h.item_id = x.item_id and h.supplier_id = x.supplier_id) as qty_purchased,
       x.created_at, x.updated_at
  from inv.item_supplier x
  join inv.item i on i.id = x.item_id
  join inv.supplier s on s.id = x.supplier_id
  left join lateral (
    select h.* from inv.v_purchase_history h
     where h.item_id = x.item_id and h.supplier_id = x.supplier_id
     order by h.received_at desc, h.receipt_number desc limit 1
  ) lp on true;

-- One row per item: preferred supplier + the last purchase from ANY supplier.
create or replace view inv.v_item_purchase_info as
select i.id as item_id, i.sku,
       pref.supplier_id as preferred_supplier_id, pref.supplier_name as preferred_supplier,
       pref.supplier_sku as preferred_supplier_sku,
       (select count(*)::int from inv.item_supplier x where x.item_id = i.id) as supplier_count,
       lp.supplier_id as last_supplier_id, lp.supplier_name as last_supplier,
       lp.received_at as last_purchase_at, lp.unit_cost as last_unit_cost, lp.currency as last_currency,
       lp.unit_cost_nok as last_unit_cost_nok, lp.po_number as last_po_number
  from inv.item i
  left join lateral (
    select x.supplier_id, s.name as supplier_name, x.supplier_sku
      from inv.item_supplier x join inv.supplier s on s.id = x.supplier_id
     where x.item_id = i.id and x.preferred limit 1
  ) pref on true
  left join lateral (
    select h.* from inv.v_purchase_history h where h.item_id = i.id
     order by h.received_at desc, h.receipt_number desc limit 1
  ) lp on true;

create or replace view inv.v_supplier as
select s.*,
       (select count(*)::int from inv.item_supplier x where x.supplier_id = s.id) as item_count,
       (select count(*)::int from inv.item_supplier x where x.supplier_id = s.id and x.preferred) as preferred_count,
       (select count(*)::int from inv.purchase_order po where po.supplier_uuid = s.id and po.status in ('sent','partially_received')) as open_po_count,
       (select max(h.received_at) from inv.v_purchase_history h where h.supplier_id = s.id) as last_receipt_at
  from inv.supplier s;

-- ---------------------------------------------------------------------------
-- API functions (jsonb in/out)
-- ---------------------------------------------------------------------------
-- p: { id?, name, code?, currency?, contact_name?, email?, phone?, website?,
--      default_lead_time_days?, note?, active? }   → supplier (create or update by id)
create or replace function inv.upsert_supplier(p jsonb) returns jsonb
language plpgsql as $$
declare v uuid := case when inv._is_uuid(inv._jtext(p, 'id')) then inv._jtext(p, 'id')::uuid end;
begin
  if v is null then
    if inv._jtext(p, 'name') is null then perform inv._raise('VALIDATION', 'name is required', '{"field":"name"}'); end if;
    if inv._find_supplier(inv._jtext(p, 'name')) is not null then
      perform inv._raise('DUPLICATE_REF', format('supplier %s already exists', inv._jtext(p, 'name')), jsonb_build_object('name', inv._jtext(p, 'name')));
    end if;
    insert into inv.supplier (name, code, currency, contact_name, email, phone, website, default_lead_time_days, note, active)
    values (btrim(inv._jtext(p, 'name')), inv._jtext(p, 'code'),
            upper(coalesce(inv._jtext(p, 'currency'), inv._setting('base_currency'), 'NOK')),
            inv._jtext(p, 'contact_name'), inv._jtext(p, 'email'), inv._jtext(p, 'phone'), inv._jtext(p, 'website'),
            (p->>'default_lead_time_days')::int, inv._jtext(p, 'note'), coalesce((p->>'active')::boolean, true))
    returning id into v;
  else
    if not exists (select 1 from inv.supplier where id = v) then
      perform inv._raise('SUPPLIER_NOT_FOUND', 'supplier not found', jsonb_build_object('supplier', v));
    end if;
    update inv.supplier set
      name                   = case when p ? 'name' then btrim(inv._jtext(p, 'name')) else name end,
      code                   = case when p ? 'code' then inv._jtext(p, 'code') else code end,
      currency               = case when p ? 'currency' then upper(inv._jtext(p, 'currency')) else currency end,
      contact_name           = case when p ? 'contact_name' then inv._jtext(p, 'contact_name') else contact_name end,
      email                  = case when p ? 'email' then inv._jtext(p, 'email') else email end,
      phone                  = case when p ? 'phone' then inv._jtext(p, 'phone') else phone end,
      website                = case when p ? 'website' then inv._jtext(p, 'website') else website end,
      default_lead_time_days = case when p ? 'default_lead_time_days' then (p->>'default_lead_time_days')::int else default_lead_time_days end,
      note                   = case when p ? 'note' then inv._jtext(p, 'note') else note end,
      active                 = case when p ? 'active' then (p->>'active')::boolean else active end
    where id = v;
    -- open POs follow a rename
    update inv.purchase_order set supplier_name = (select name from inv.supplier where id = v)
     where supplier_uuid = v and supplier_name is distinct from (select name from inv.supplier where id = v);
  end if;
  return (select to_jsonb(s) from inv.v_supplier s where s.id = v);
end $$;

-- p: { sku, supplier (uuid | code | name), preferred?, supplier_sku?, list_price?, list_currency?,
--      lead_time_days?, min_order_qty?, note?, create_supplier? }
-- Creates or updates the item ↔ supplier link. preferred=true moves the preference here.
create or replace function inv.set_item_supplier(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_item uuid := inv._resolve_item(inv._jtext(p, 'sku'));
  v_ref  text := coalesce(inv._jtext(p, 'supplier'), inv._jtext(p, 'supplier_id'), inv._jtext(p, 'supplier_name'));
  v_sup  uuid;
begin
  v_sup := case when coalesce((p->>'create_supplier')::boolean, false) then inv._ensure_supplier(v_ref) else inv._resolve_supplier(v_ref) end;
  perform inv._link_item_supplier(v_item, v_sup);
  if coalesce((p->>'preferred')::boolean, false) then
    update inv.item_supplier set preferred = false where item_id = v_item and supplier_id <> v_sup and preferred;
  end if;
  update inv.item_supplier set
    preferred      = case when p ? 'preferred' and (p->>'preferred') is not null then (p->>'preferred')::boolean else preferred end,
    supplier_sku   = case when p ? 'supplier_sku' then inv._jtext(p, 'supplier_sku') else supplier_sku end,
    list_price     = case when p ? 'list_price' then inv._jnum(p, 'list_price') else list_price end,
    list_currency  = case when p ? 'list_currency' then upper(inv._jtext(p, 'list_currency')) else list_currency end,
    lead_time_days = case when p ? 'lead_time_days' then (p->>'lead_time_days')::int else lead_time_days end,
    min_order_qty  = case when p ? 'min_order_qty' then inv._jnum(p, 'min_order_qty') else min_order_qty end,
    note           = case when p ? 'note' then inv._jtext(p, 'note') else note end
  where item_id = v_item and supplier_id = v_sup;
  return inv.list_item_suppliers(inv._sku(v_item));
end $$;

-- p: { sku, supplier }  → removes the link; if it was preferred, the supplier bought from
-- most recently (else the oldest link) becomes preferred.
create or replace function inv.remove_item_supplier(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_item uuid := inv._resolve_item(inv._jtext(p, 'sku'));
  v_sup  uuid := inv._resolve_supplier(coalesce(inv._jtext(p, 'supplier'), inv._jtext(p, 'supplier_id')));
  v_was  boolean;
begin
  delete from inv.item_supplier where item_id = v_item and supplier_id = v_sup returning preferred into v_was;
  if v_was is null then
    perform inv._raise('NOT_FOUND', 'supplier is not linked to this item', jsonb_build_object('sku', inv._sku(v_item)));
  end if;
  if v_was then
    update inv.item_supplier set preferred = true
     where item_id = v_item and supplier_id = (
       select x.supplier_id from inv.v_item_supplier x where x.item_id = v_item
        order by x.last_purchase_at desc nulls last, x.created_at limit 1);
  end if;
  return inv.list_item_suppliers(inv._sku(v_item));
end $$;

create or replace function inv.list_item_suppliers(p_sku text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'item_id' order by x.preferred desc, x.last_purchase_at desc nulls last, x.supplier_name), '[]'::jsonb)
    from inv.v_item_supplier x where x.item_id = inv._resolve_item(p_sku)
$$;

-- p: { rows: [{ sku, supplier, supplier_sku?, preferred?, list_price?, list_currency?,
--               lead_time_days?, min_order_qty? }], dry_run?, create_suppliers? }
-- All-or-nothing: every row is validated first; nothing is written when one row fails.
create or replace function inv.import_item_suppliers(p jsonb) returns jsonb
language plpgsql as $$
declare
  r jsonb; i int := 0; v_errors jsonb := '[]'; v_rows jsonb := '[]';
  v_item uuid; v_sup uuid; v_ref text; v_new_sup jsonb := '[]';
  v_dry boolean := coalesce((p->>'dry_run')::boolean, false);
  v_create boolean := coalesce((p->>'create_suppliers')::boolean, false);
  v_pref_seen text[] := '{}';
begin
  if jsonb_typeof(p->'rows') <> 'array' or jsonb_array_length(p->'rows') = 0 then
    perform inv._raise('VALIDATION', 'rows must be a non-empty array');
  end if;
  for r in select * from jsonb_array_elements(p->'rows') loop
    i := i + 1;
    v_ref := coalesce(inv._jtext(r, 'supplier'), inv._jtext(r, 'supplier_name'));
    select id into v_item from inv.item where upper(sku) = upper(inv._jtext(r, 'sku'));
    v_sup := inv._find_supplier(v_ref);
    if inv._jtext(r, 'sku') is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'error', 'sku is required');
    elsif v_item is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'sku', inv._jtext(r, 'sku'), 'error', 'unknown sku');
    elsif v_ref is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'sku', inv._jtext(r, 'sku'), 'error', 'supplier is required');
    elsif v_sup is null and not v_create then
      v_errors := v_errors || jsonb_build_object('row', i, 'sku', inv._jtext(r, 'sku'), 'supplier', v_ref, 'error', 'unknown supplier');
    elsif coalesce((r->>'preferred')::boolean, false) and upper(inv._jtext(r, 'sku')) = any (v_pref_seen) then
      v_errors := v_errors || jsonb_build_object('row', i, 'sku', inv._jtext(r, 'sku'), 'error', 'more than one preferred supplier for this sku');
    else
      if coalesce((r->>'preferred')::boolean, false) then v_pref_seen := v_pref_seen || upper(inv._jtext(r, 'sku')); end if;
      if v_sup is null and not (v_new_sup @> jsonb_build_array(lower(btrim(v_ref)))) then
        v_new_sup := v_new_sup || jsonb_build_array(lower(btrim(v_ref)));
      end if;
      v_rows := v_rows || jsonb_build_object('row', i, 'sku', inv._sku(v_item), 'supplier', coalesce((select name from inv.supplier where id = v_sup), btrim(v_ref)),
        'new_supplier', v_sup is null,
        'already_linked', v_sup is not null and exists (select 1 from inv.item_supplier x where x.item_id = v_item and x.supplier_id = v_sup));
    end if;
  end loop;
  if jsonb_array_length(v_errors) > 0 or v_dry then
    return jsonb_build_object('ok', jsonb_array_length(v_errors) = 0, 'dry_run', v_dry, 'errors', v_errors,
      'rows', v_rows, 'new_suppliers', jsonb_array_length(v_new_sup));
  end if;
  for r in select * from jsonb_array_elements(p->'rows') loop
    perform inv.set_item_supplier(r || jsonb_build_object('supplier', coalesce(inv._jtext(r, 'supplier'), inv._jtext(r, 'supplier_name')),
                                                           'create_supplier', v_create));
  end loop;
  return jsonb_build_object('ok', true, 'dry_run', false, 'linked', jsonb_array_length(v_rows),
    'new_suppliers', jsonb_array_length(v_new_sup));
end $$;

-- get_item_status now also returns suppliers[] and purchase{} (last purchase + preferred supplier).
create or replace function inv.get_item_status(p_sku text) returns jsonb
language sql stable as $$
  select to_jsonb(s)
         || jsonb_build_object('layers', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', cl.id, 'location', l.code, 'received_at', cl.received_at,
                       'qty_in', cl.qty_in, 'qty_remaining', cl.qty_remaining, 'unit_cost', cl.unit_cost,
                       'movement_id', cl.movement_id, 'reference', m.reference)
                     order by cl.received_at, cl.id)
              from inv.cost_layer cl
              join inv.location l on l.id = cl.location_id
              join inv.movement m on m.id = cl.movement_id
              where cl.item_id = s.item_id and cl.qty_remaining > 0), '[]'::jsonb))
         || jsonb_build_object('suppliers', inv.list_item_suppliers(s.sku))
         || jsonb_build_object('purchase', (select to_jsonb(pi) - 'item_id' - 'sku' from inv.v_item_purchase_info pi where pi.item_id = s.item_id))
  from inv.v_item_status s
  where s.item_id = inv._resolve_item(p_sku)
$$;

-- Server-only, like the rest of inv (see 0006).
revoke all on inv.supplier, inv.item_supplier from public;
revoke all on inv.v_purchase_history, inv.v_item_supplier, inv.v_item_purchase_info, inv.v_supplier from public;
revoke execute on function inv.upsert_supplier(jsonb), inv.set_item_supplier(jsonb), inv.remove_item_supplier(jsonb),
  inv.list_item_suppliers(text), inv.import_item_suppliers(jsonb) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema inv from %I', r);
      execute format('revoke all on all functions in schema inv from %I', r);
    end if;
  end loop;
end $$;

update inv.settings set value = '0.7.0', updated_at = now() where key = 'schema_version';

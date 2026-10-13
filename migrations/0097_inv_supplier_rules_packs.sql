-- inventory-ledger v0.10.0
-- =============================================================================
-- 0097_inv_supplier_rules_packs.sql — supplier rules (checklist) and buying in packs
-- =============================================================================
-- Many suppliers invoice in packs/cases, not in the units we stock and sell:
-- Nestlé's "LK DogDry Du/Sal&Ven (4x2,5kg)" quantity 1 is ONE case that holds four
-- 2.5 kg bags — four bags go on stock. This migration lets the ledger know that.
--
--   inv.supplier.rules        jsonb array of strings — the supplier's checklist
--                             ("invoice quantities are cases", "use the EHF net price"…).
--                             Shown on purchase orders and receipts; read by agents.
--   inv.supplier.order_unit   'unit' (default) | 'pack' — what the supplier's invoices and
--                             order confirmations count in.
--   inv.item_supplier         pack_qty  units of OUR item in one supplier pack (null = unknown)
--                             pack_name e.g. 'case 4 × 2.5 kg'
--                             pack_gtin the GTIN of the supplier pack (as on the EHF invoice)
--   inv.purchase_order_line   packs, pack_qty, supplier_sku — what was ordered in packs.
--
-- PO lines (create/update) may now be given in packs and by the supplier's identifiers:
--   { sku | supplier_sku | gtin, packs, pack_qty?, pack_price?, description? }
--   → qty = packs × pack_qty, unit_cost = pack_price / pack_qty.
--   pack_qty: the line's, else the item↔supplier link's, else parsed from the description
--   ("(4x2,5kg)" → 4, "(6x400g)" → 6, "(7kg)" → 1), else 1. A line identified by
--   supplier_sku / gtin must already be linked to one of our SKUs.
--   What a line teaches is stored on the link (pack_qty, supplier_sku, pack_gtin) when the
--   link does not know it yet — the next invoice matches on its own.
--
-- inv.match_supplier_lines(p) previews invoice lines against the links (no writes):
--   which SKU, how many units, unit cost per unit — and what is not linked yet.
-- =============================================================================

alter table inv.supplier add column if not exists rules jsonb not null default '[]';
alter table inv.supplier add column if not exists order_unit text not null default 'unit';
do $$ begin
  alter table inv.supplier add constraint supplier_order_unit_check check (order_unit in ('unit', 'pack'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table inv.supplier add constraint supplier_rules_array check (jsonb_typeof(rules) = 'array');
exception when duplicate_object then null; end $$;

alter table inv.item_supplier add column if not exists pack_qty numeric(14,3);
alter table inv.item_supplier add column if not exists pack_name text;
alter table inv.item_supplier add column if not exists pack_gtin text;
do $$ begin
  alter table inv.item_supplier add constraint item_supplier_pack_qty_check check (pack_qty is null or pack_qty > 0);
exception when duplicate_object then null; end $$;
create index if not exists idx_item_supplier_ref on inv.item_supplier (supplier_id, (ltrim(lower(btrim(supplier_sku)), '0')));
create index if not exists idx_item_supplier_gtin on inv.item_supplier (supplier_id, (ltrim(btrim(pack_gtin), '0')));

alter table inv.purchase_order_line add column if not exists packs numeric(14,3);
alter table inv.purchase_order_line add column if not exists pack_qty numeric(14,3);
alter table inv.purchase_order_line add column if not exists supplier_sku text;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Supplier article numbers often come zero-padded ("000000000012583641"); compare without.
create or replace function inv._norm_ref(p text) returns text
language sql immutable as $$
  select nullif(ltrim(lower(btrim(p)), '0'), '')
$$;

-- Units per pack from a product text: "(4x2,5kg)" → 4, "(6 x 400 g)" → 6, "(1x7kg)" → 1,
-- "(7kg)" → 1. Null when the text says nothing about a pack.
create or replace function inv._pack_qty_from_text(p text) returns numeric
language plpgsql immutable as $$
declare m text[];
begin
  if p is null then return null; end if;
  m := regexp_match(p, '\(\s*(\d+)\s*[x×]\s*\d+(?:\s*[.,]\s*\d+)?\s*(?:kg|g|ml|cl|l|stk|pcs|pk)?\s*\)', 'i');
  if m is not null then return m[1]::numeric; end if;
  if p ~* '\(\s*\d+(?:\s*[.,]\s*\d+)?\s*(?:kg|g|ml|cl|l)\s*\)' then return 1; end if;
  return null;
end $$;

-- The item ↔ supplier link for a supplier article number or pack GTIN (zeros ignored).
create or replace function inv._find_supplier_item(p_supplier uuid, p_ref text, p_gtin text) returns inv.item_supplier
language sql stable as $$
  select x.* from inv.item_supplier x
   where x.supplier_id = p_supplier
     and ((inv._norm_ref(p_ref) is not null and ltrim(lower(btrim(x.supplier_sku)), '0') = inv._norm_ref(p_ref))
       or (inv._norm_ref(p_gtin) is not null and ltrim(btrim(x.pack_gtin), '0') = inv._norm_ref(p_gtin)))
   order by (inv._norm_ref(p_ref) is not null and ltrim(lower(btrim(x.supplier_sku)), '0') = inv._norm_ref(p_ref)) desc,
            x.preferred desc
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- PO lines: units or packs, by our SKU or the supplier's identifiers
-- ---------------------------------------------------------------------------
create or replace function inv._po_replace_lines(p_po uuid, p_lines jsonb) returns void
language plpgsql as $$
declare
  e jsonb; v_pos int := 0; v_item uuid; v_qty numeric; v_cost numeric;
  v_sup uuid; v_link inv.item_supplier; v_packs numeric; v_pack_qty numeric; v_pack_price numeric;
  v_ref text; v_gtin text; v_label text;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform inv._raise('VALIDATION', 'lines must be a non-empty array');
  end if;
  select supplier_uuid into v_sup from inv.purchase_order where id = p_po;
  delete from inv.purchase_order_line where po_id = p_po;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_pos := v_pos + 1;
    v_ref  := inv._jtext(e, 'supplier_sku');
    v_gtin := coalesce(inv._jtext(e, 'gtin'), inv._jtext(e, 'pack_gtin'));
    v_label := coalesce(inv._jtext(e, 'sku'), v_ref, v_gtin, inv._jtext(e, 'description'), format('line %s', v_pos));
    v_link := null;

    if inv._jtext(e, 'sku') is not null then
      v_item := inv._resolve_item(inv._jtext(e, 'sku'));
      select * into v_link from inv.item_supplier where item_id = v_item and supplier_id = v_sup;
    elsif v_ref is not null or v_gtin is not null then
      v_link := inv._find_supplier_item(v_sup, v_ref, v_gtin);
      if v_link.item_id is null then
        perform inv._raise('ITEM_NOT_FOUND',
          format('line %s: supplier item %s is not linked to one of our SKUs — give sku (it is linked when saved)', v_pos, v_label),
          jsonb_build_object('line', v_pos, 'supplier_sku', v_ref, 'gtin', v_gtin, 'description', inv._jtext(e, 'description')));
      end if;
      v_item := v_link.item_id;
    else
      perform inv._raise('VALIDATION', format('line %s: sku (or supplier_sku / gtin) is required', v_pos), jsonb_build_object('line', v_pos));
    end if;

    v_packs := inv._jnum(e, 'packs');
    v_pack_qty := null;
    v_qty  := inv._jnum(e, 'qty');
    v_cost := inv._jnum(e, 'unit_cost');
    v_pack_price := inv._jnum(e, 'pack_price');
    if v_packs is not null then
      if v_packs <= 0 then perform inv._raise('VALIDATION', format('line %s: packs must be > 0', v_pos), jsonb_build_object('line', v_pos)); end if;
      v_pack_qty := coalesce(inv._jnum(e, 'pack_qty'), v_link.pack_qty, inv._pack_qty_from_text(inv._jtext(e, 'description')), 1);
      if v_pack_qty <= 0 then perform inv._raise('VALIDATION', format('line %s: pack_qty must be > 0', v_pos), jsonb_build_object('line', v_pos)); end if;
      if v_qty is not null and v_qty <> v_packs * v_pack_qty then
        perform inv._raise('VALIDATION', format('line %s: qty %s does not match %s packs × %s', v_pos, v_qty, v_packs, v_pack_qty),
          jsonb_build_object('line', v_pos, 'qty', v_qty, 'packs', v_packs, 'pack_qty', v_pack_qty));
      end if;
      v_qty := v_packs * v_pack_qty;
      if v_pack_price is not null then
        if v_cost is not null and abs(v_cost - round(v_pack_price / v_pack_qty, 4)) > 0.0001 then
          perform inv._raise('VALIDATION', format('line %s: give unit_cost or pack_price, not two different prices', v_pos), jsonb_build_object('line', v_pos));
        end if;
        v_cost := round(v_pack_price / v_pack_qty, 4);
      end if;
    elsif v_pack_price is not null and v_cost is null then
      perform inv._raise('VALIDATION', format('line %s: pack_price needs packs', v_pos), jsonb_build_object('line', v_pos));
    end if;

    if v_qty is null or v_qty <= 0 then
      perform inv._raise('VALIDATION', format('line %s: qty (or packs) must be > 0', v_pos), jsonb_build_object('line', v_pos));
    end if;
    if v_cost is null or v_cost < 0 then
      perform inv._raise('VALIDATION', format('line %s: unit_cost (or pack_price) is required and must be >= 0', v_pos), jsonb_build_object('line', v_pos));
    end if;
    begin
      insert into inv.purchase_order_line (po_id, position, item_id, sku, qty_ordered, unit_cost, landed_cost_per_unit, note,
                                           packs, pack_qty, supplier_sku)
      values (p_po, v_pos, v_item, inv._sku(v_item), v_qty, v_cost,
              coalesce(inv._jnum(e, 'landed_cost_per_unit'), 0), inv._jtext(e, 'note'),
              v_packs, v_pack_qty, coalesce(v_ref, v_link.supplier_sku));
    exception when unique_violation then
      perform inv._raise('VALIDATION', format('sku %s appears more than once', inv._sku(v_item)),
        jsonb_build_object('line', v_pos));
    end;

    -- Learn: the link (created by trg_pol_link_supplier) keeps what this line told us.
    if v_sup is not null then
      update inv.item_supplier set
        pack_qty     = coalesce(pack_qty, case when v_packs is not null and (e ? 'pack_qty' or inv._pack_qty_from_text(inv._jtext(e, 'description')) is not null)
                                               then v_pack_qty end),
        supplier_sku = coalesce(supplier_sku, v_ref),
        pack_gtin    = coalesce(pack_gtin, v_gtin)
      where item_id = v_item and supplier_id = v_sup
        and ((pack_qty is null and v_packs is not null) or (supplier_sku is null and v_ref is not null) or (pack_gtin is null and v_gtin is not null));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Invoice preview: match supplier lines to our SKUs and convert packs → units
-- p: { supplier, qty_in?: 'pack'|'unit' (default: the supplier's order_unit),
--      lines: [{ supplier_sku?, gtin?, description?, qty, net_amount? | unit_price? }] }
-- → { supplier, qty_in, rules, matched, unmatched, total_net, lines: [{ row, matched, sku, item_name,
--     supplier_sku, gtin, description, qty, pack_qty, pack_qty_source, units, pack_price, unit_cost,
--     net_amount, po_line }] }
-- po_line is ready for create_purchase_order (sku + packs + pack_qty + pack_price) when matched.
-- ---------------------------------------------------------------------------
create or replace function inv.match_supplier_lines(p jsonb) returns jsonb
language plpgsql stable as $$
declare
  v_sup inv.supplier;
  v_in text;
  r jsonb; i int := 0; v_out jsonb := '[]';
  v_link inv.item_supplier; v_qty numeric; v_pq numeric; v_src text; v_net numeric; v_pp numeric;
  v_matched int := 0; v_total numeric := 0;
begin
  select * into v_sup from inv.supplier where id = inv._resolve_supplier(coalesce(inv._jtext(p, 'supplier'), inv._jtext(p, 'supplier_id')));
  v_in := coalesce(nullif(inv._jtext(p, 'qty_in'), ''), v_sup.order_unit);
  if v_in not in ('unit', 'pack') then perform inv._raise('VALIDATION', 'qty_in must be unit or pack', '{"field":"qty_in"}'); end if;
  if jsonb_typeof(p->'lines') <> 'array' then perform inv._raise('VALIDATION', 'lines must be an array', '{"field":"lines"}'); end if;

  for r in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    v_link := inv._find_supplier_item(v_sup.id, inv._jtext(r, 'supplier_sku'), coalesce(inv._jtext(r, 'gtin'), inv._jtext(r, 'pack_gtin')));
    if v_link.item_id is null and inv._jtext(r, 'sku') is not null then
      select x.* into v_link from inv.item_supplier x join inv.item it on it.id = x.item_id
       where x.supplier_id = v_sup.id and upper(it.sku) = upper(inv._jtext(r, 'sku'));
    end if;
    v_qty := coalesce(inv._jnum(r, 'qty'), 0);
    if v_in = 'pack' then
      v_pq := coalesce(inv._jnum(r, 'pack_qty'), v_link.pack_qty, inv._pack_qty_from_text(inv._jtext(r, 'description')));
      v_src := case when inv._jnum(r, 'pack_qty') is not null then 'line' when v_link.pack_qty is not null then 'link'
                    when v_pq is not null then 'description' else 'default' end;
      v_pq := coalesce(v_pq, 1);
    else
      v_pq := 1; v_src := 'unit';
    end if;
    v_net := coalesce(inv._jnum(r, 'net_amount'), case when inv._jnum(r, 'unit_price') is not null then inv._jnum(r, 'unit_price') * v_qty end);
    v_pp := case when v_net is not null and v_qty > 0 then round(v_net / v_qty, 4) end;
    if v_link.item_id is not null then v_matched := v_matched + 1; end if;
    v_total := v_total + coalesce(v_net, 0);
    v_out := v_out || jsonb_build_object(
      'row', i, 'matched', v_link.item_id is not null,
      'sku', inv._sku(v_link.item_id), 'item_name', (select name from inv.item where id = v_link.item_id),
      'supplier_sku', inv._jtext(r, 'supplier_sku'), 'gtin', coalesce(inv._jtext(r, 'gtin'), inv._jtext(r, 'pack_gtin')),
      'description', inv._jtext(r, 'description'),
      'qty', v_qty, 'pack_qty', v_pq, 'pack_qty_source', v_src, 'units', v_qty * v_pq,
      'pack_price', v_pp, 'unit_cost', case when v_pp is not null then round(v_pp / v_pq, 4) end, 'net_amount', v_net,
      'po_line', case when v_link.item_id is not null and v_qty > 0 then jsonb_strip_nulls(jsonb_build_object(
          'sku', inv._sku(v_link.item_id), 'packs', v_qty, 'pack_qty', v_pq, 'pack_price', v_pp,
          'supplier_sku', inv._jtext(r, 'supplier_sku'), 'gtin', coalesce(inv._jtext(r, 'gtin'), inv._jtext(r, 'pack_gtin')),
          'description', inv._jtext(r, 'description'))) end);
  end loop;
  return jsonb_build_object('supplier', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'order_unit', v_sup.order_unit),
    'qty_in', v_in, 'rules', v_sup.rules, 'matched', v_matched, 'unmatched', i - v_matched,
    'total_net', round(v_total, 2), 'lines', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- Supplier API: rules + order_unit; item links: pack fields
-- ---------------------------------------------------------------------------
create or replace function inv._rules_json(p jsonb) returns jsonb
language plpgsql stable as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return '[]'; end if;
  if jsonb_typeof(p) = 'string' then   -- one rule per line
    return coalesce((select jsonb_agg(btrim(x)) from regexp_split_to_table(p #>> '{}', E'\n') x where btrim(x) <> ''), '[]');
  end if;
  if jsonb_typeof(p) <> 'array' then perform inv._raise('VALIDATION', 'rules must be an array of strings', '{"field":"rules"}'); end if;
  return coalesce((select jsonb_agg(btrim(x)) from jsonb_array_elements_text(p) x where btrim(x) <> ''), '[]');
end $$;

drop view if exists inv.v_supplier;
create view inv.v_supplier as
select s.*,
       (select count(*)::int from inv.item_supplier x where x.supplier_id = s.id) as item_count,
       (select count(*)::int from inv.item_supplier x where x.supplier_id = s.id and x.preferred) as preferred_count,
       (select count(*)::int from inv.purchase_order po where po.supplier_uuid = s.id and po.status in ('sent','partially_received')) as open_po_count,
       (select max(h.received_at) from inv.v_purchase_history h where h.supplier_id = s.id) as last_receipt_at
  from inv.supplier s;

create or replace view inv.v_item_supplier as
select x.item_id, i.sku, x.supplier_id, s.name as supplier_name, s.code as supplier_code, s.active as supplier_active,
       x.preferred, x.supplier_sku, x.list_price, coalesce(x.list_currency, s.currency) as list_currency,
       coalesce(x.lead_time_days, s.default_lead_time_days) as lead_time_days, x.min_order_qty, x.note,
       lp.received_at as last_purchase_at, lp.unit_cost as last_unit_cost, lp.currency as last_currency,
       lp.unit_cost_nok as last_unit_cost_nok, lp.qty as last_qty, lp.po_number as last_po_number,
       (select coalesce(sum(h.qty), 0) from inv.v_purchase_history h where h.item_id = x.item_id and h.supplier_id = x.supplier_id) as qty_purchased,
       x.created_at, x.updated_at,
       x.pack_qty, x.pack_name, x.pack_gtin, s.order_unit as supplier_order_unit
  from inv.item_supplier x
  join inv.item i on i.id = x.item_id
  join inv.supplier s on s.id = x.supplier_id
  left join lateral (
    select h.* from inv.v_purchase_history h
     where h.item_id = x.item_id and h.supplier_id = x.supplier_id
     order by h.received_at desc, h.receipt_number desc limit 1
  ) lp on true;

create or replace function inv.upsert_supplier(p jsonb) returns jsonb
language plpgsql as $$
declare v uuid := inv._to_uuid(inv._jtext(p, 'id'));
begin
  if p ? 'order_unit' and coalesce(inv._jtext(p, 'order_unit'), '') not in ('unit', 'pack') then
    perform inv._raise('VALIDATION', 'order_unit must be unit or pack', '{"field":"order_unit"}');
  end if;
  if v is null then
    if inv._jtext(p, 'name') is null then perform inv._raise('VALIDATION', 'name is required', '{"field":"name"}'); end if;
    if inv._find_supplier(inv._jtext(p, 'name')) is not null then
      perform inv._raise('DUPLICATE_REF', format('supplier %s already exists', inv._jtext(p, 'name')), jsonb_build_object('name', inv._jtext(p, 'name')));
    end if;
    insert into inv.supplier (name, code, currency, contact_name, email, phone, website, default_lead_time_days, note, active,
                              rules, order_unit)
    values (btrim(inv._jtext(p, 'name')), inv._jtext(p, 'code'),
            upper(coalesce(inv._jtext(p, 'currency'), inv._setting('base_currency'), 'NOK')),
            inv._jtext(p, 'contact_name'), inv._jtext(p, 'email'), inv._jtext(p, 'phone'), inv._jtext(p, 'website'),
            (p->>'default_lead_time_days')::int, inv._jtext(p, 'note'), coalesce((p->>'active')::boolean, true),
            inv._rules_json(p->'rules'), coalesce(inv._jtext(p, 'order_unit'), 'unit'))
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
      active                 = case when p ? 'active' then (p->>'active')::boolean else active end,
      rules                  = case when p ? 'rules' then inv._rules_json(p->'rules') else rules end,
      order_unit             = case when p ? 'order_unit' then inv._jtext(p, 'order_unit') else order_unit end
    where id = v;
    update inv.purchase_order set supplier_name = (select name from inv.supplier where id = v)
     where supplier_uuid = v and supplier_name is distinct from (select name from inv.supplier where id = v);
  end if;
  return (select to_jsonb(s) from inv.v_supplier s where s.id = v);
end $$;

-- p: { sku, supplier, preferred?, supplier_sku?, list_price?, list_currency?, lead_time_days?,
--      min_order_qty?, note?, pack_qty?, pack_name?, pack_gtin?, create_supplier? }
create or replace function inv.set_item_supplier(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_item uuid := inv._resolve_item(inv._jtext(p, 'sku'));
  v_ref  text := coalesce(inv._jtext(p, 'supplier'), inv._jtext(p, 'supplier_id'), inv._jtext(p, 'supplier_name'));
  v_sup  uuid;
begin
  if p ? 'pack_qty' and inv._jnum(p, 'pack_qty') is not null and inv._jnum(p, 'pack_qty') <= 0 then
    perform inv._raise('VALIDATION', 'pack_qty must be > 0', '{"field":"pack_qty"}');
  end if;
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
    note           = case when p ? 'note' then inv._jtext(p, 'note') else note end,
    pack_qty       = case when p ? 'pack_qty' then inv._jnum(p, 'pack_qty') else pack_qty end,
    pack_name      = case when p ? 'pack_name' then inv._jtext(p, 'pack_name') else pack_name end,
    pack_gtin      = case when p ? 'pack_gtin' then inv._jtext(p, 'pack_gtin') else pack_gtin end
  where item_id = v_item and supplier_id = v_sup;
  return inv.list_item_suppliers(inv._sku(v_item));
end $$;

revoke execute on function inv._norm_ref(text), inv._pack_qty_from_text(text), inv._find_supplier_item(uuid, text, text),
  inv.match_supplier_lines(jsonb), inv._rules_json(jsonb) from public;
revoke all on inv.v_supplier, inv.v_item_supplier from public;
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

update inv.settings set value = '0.10.0', updated_at = now() where key = 'schema_version';

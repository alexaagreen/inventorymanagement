-- inventory-ledger v0.8.0
-- =============================================================================
-- 0095_inv_supplier_uuid_fix.sql — re-create the supplier lookups without uuid casts
-- =============================================================================
-- The first published 0093 guarded `p_ref::uuid` with `_is_uuid(p_ref) and …`. SQL
-- does not short-circuit: with Supabase's random_page_cost = 1.1 the planner uses a
-- BitmapOr on supplier_pkey / code / name and evaluates the cast as an index
-- condition first, so looking up a supplier by name failed with
-- "invalid input syntax for type uuid" once the register had rows.
--
-- 0093 has since been fixed in place (it failed and rolled back where it hit this).
-- This migration brings any database that applied the ORIGINAL 0093 onto the same
-- code. On a database that ran the fixed 0093 it is a no-op re-definition.
-- =============================================================================

create or replace function inv._to_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  if inv._is_uuid(btrim(p)) then return btrim(p)::uuid; end if;
  return null;
end $$;

create or replace function inv._find_supplier(p_ref text) returns uuid
language sql stable as $$
  select s.id from inv.supplier s
   where s.id = inv._to_uuid(p_ref)
      or s.code = p_ref
      or lower(btrim(s.name)) = lower(btrim(p_ref))
   order by (s.id = inv._to_uuid(p_ref)) desc nulls last, (s.code = p_ref) desc nulls last
   limit 1
$$;

create or replace function inv._po_resolve_supplier() returns trigger
language plpgsql as $$
begin
  if new.supplier_uuid is null
     or (tg_op = 'UPDATE' and new.supplier_name is distinct from old.supplier_name and new.supplier_uuid = old.supplier_uuid)
     or (tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id and inv._is_uuid(new.supplier_id)) then
    if exists (select 1 from inv.supplier s where s.id = inv._to_uuid(new.supplier_id)) then
      new.supplier_uuid := inv._to_uuid(new.supplier_id);
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

revoke execute on function inv._to_uuid(text) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema inv from %I', r);
    end if;
  end loop;
end $$;

-- inventory-ledger v0.6.0
-- =============================================================================
-- 0006_inv_grants.sql — `inv` is not for the browser
-- =============================================================================
-- `inv` lives in the storefront Supabase, where the anon key is public. Stock must
-- only be reached server-side (internal-web via INVENTORY_DATABASE_URL / service role).
-- Removes all access for PUBLIC, anon and authenticated — including future objects.
-- Idempotent; tolerates missing Supabase roles (local Postgres / CI).
-- =============================================================================

revoke all on schema inv from public;
revoke all on all tables in schema inv from public;
revoke all on all sequences in schema inv from public;
revoke execute on all functions in schema inv from public;
alter default privileges in schema inv revoke all on tables from public;
alter default privileges in schema inv revoke all on sequences from public;
alter default privileges in schema inv revoke execute on functions from public;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema inv from %I', r);
      execute format('revoke all on all tables in schema inv from %I', r);
      execute format('revoke all on all sequences in schema inv from %I', r);
      execute format('revoke execute on all functions in schema inv from %I', r);
      execute format('alter default privileges in schema inv revoke all on tables from %I', r);
      execute format('alter default privileges in schema inv revoke all on sequences from %I', r);
      execute format('alter default privileges in schema inv revoke execute on functions from %I', r);
    end if;
  end loop;
end $$;

update inv.settings set value = '0.5.0', updated_at = now() where key = 'schema_version';

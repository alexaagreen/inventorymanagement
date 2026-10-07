-- inventory-ledger v0.5.0
-- =============================================================================
-- 0006_inv_grants.sql — `inv` er IKKE for nettleseren
-- =============================================================================
-- `inv` bor i nettbutikkens Supabase, der anon-nøkkelen er offentlig. Lageret skal
-- bare nås server-side (internal-web via INVENTORY_DATABASE_URL / service role).
-- Fjerner all tilgang for PUBLIC, anon og authenticated — også for fremtidige objekter.
-- Idempotent; tåler at Supabase-rollene ikke finnes (lokal Postgres / CI).
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

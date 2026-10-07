-- M8: anon/authenticated (Supabase-roller) har ingen tilgang til inv
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
-- Simuler Supabase: noen har gitt bred tilgang, så kjøres grants-migrasjonen
grant usage on schema inv to anon;
grant select on all tables in schema inv to anon;
\ir ../../migrations/0006_inv_grants.sql
select t.item('X');
do $$
begin
  perform t.eq(has_schema_privilege('anon', 'inv', 'usage'), false, 'anon no schema usage');
  perform t.eq(has_table_privilege('anon', 'inv.movement', 'select'), false, 'anon cannot select movement');
  perform t.eq(has_table_privilege('authenticated', 'inv.item', 'insert'), false, 'authenticated cannot insert');
  perform t.eq(has_function_privilege('anon', 'inv.create_adjustment(jsonb)', 'execute'), false, 'anon cannot execute');
  perform t.eq(has_function_privilege('anon', 'inv.import_opening_balance(jsonb)', 'execute'), false, 'anon cannot import');
end $$;

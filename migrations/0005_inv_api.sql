-- inventory-ledger v0.3.0
-- =============================================================================
-- 0005_inv_api.sql — støtte for HTTP-laget (spec §6.0)
-- =============================================================================

-- Idempotency-Key: samme nøkkel → samme svar i 24 t
create table if not exists inv.idempotency_key (
  key         text primary key,
  method      text not null,
  path        text not null,
  status      int,
  response    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_idem_created on inv.idempotency_key (created_at);

create or replace function inv.prune_idempotency_keys() returns int
language plpgsql as $$
declare n int;
begin
  delete from inv.idempotency_key where created_at < now() - interval '24 hours';
  get diagnostics n = row_count;
  return n;
end $$;

-- Lokasjoner som jsonb (UI-dropdowns)
create or replace function inv.list_locations() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'is_default', is_default,
           'sellable_online', sellable_online, 'active', active) order by is_default desc, code), '[]')
  from inv.location
$$;

update inv.settings set value = '0.3.0', updated_at = now() where key = 'schema_version';

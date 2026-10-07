-- T15: Reverser salget i T1 → +12, lag 10@100 og 2@120 tilbake med opprinnelig received_at
select t.item('KNIV-1');
select t.receive('KNIV-1', 10, 100, '2026-09-01');
select t.receive('KNIV-1', 5, 120, '2026-09-05');
do $$
declare s bigint; r jsonb;
begin
  s := (inv.record_sale('{"ref_id":"S1","lines":[{"sku":"KNIV-1","qty":12}]}')->'movements'->0->>'id')::bigint;
  r := inv.reverse_movement(s, 'test', 'feilregistrert');
  perform t.eq(r->>'type', 'reversal', 'type');
  perform t.eq((r->>'qty')::numeric, 12.000, 'qty +12');
  perform t.eq((r->>'reversal_of')::bigint, s, 'reversal_of');
  perform t.eq((r->>'total_cost')::numeric, 1240.00, 'cost 1240');
  perform t.eq(jsonb_array_length(r->'layers'), 2, 'two layers recreated');
  perform t.eq((r->'layers'->0->>'received_at')::timestamptz, '2026-09-01'::timestamptz, 'original received_at');
  perform t.eq((select reversed_by from inv.movement where id = s), (r->>'id')::bigint, 'reversed_by');
  perform t.eq(t.on_hand('KNIV-1'), 15.000, 'on_hand 15');
  perform t.eq(t.value('KNIV-1'), 1600.00, 'value 1600');
  -- Neste salg skal ta 100-laget først (FIFO-plass beholdt)
  perform t.eq((inv.record_sale('{"ref_id":"S2","lines":[{"sku":"KNIV-1","qty":1}]}')->'movements'->0->>'total_cost')::numeric, 100.00, 'FIFO order kept');
  perform t.expect_error(format('select inv.reverse_movement(%s)', s), 'ALREADY_REVERSED');
  perform t.expect_error(format('select inv.reverse_movement(%s)', r->>'id'), 'VALIDATION');
  perform t.integrity();
end $$;

-- Reverser et salg som gikk negativt (udekket) → beholdning nøytraliseres uten lag
select t.item('KNIV-2');
select t.receive('KNIV-2', 1, 80, '2026-09-01');
do $$
declare s bigint; r jsonb;
begin
  s := (inv.record_sale('{"ref_id":"N1","lines":[{"sku":"KNIV-2","qty":3}]}')->'movements'->0->>'id')::bigint;
  perform t.eq(t.on_hand('KNIV-2'), -2.000, 'neg');
  r := inv.reverse_movement(s, 'test', null);
  perform t.eq((r->>'qty')::numeric, 3.000, 'reversal qty 3');
  perform t.eq(jsonb_array_length(r->'layers'), 1, 'only covered part gets a layer');
  perform t.eq(t.on_hand('KNIV-2'), 1.000, 'back to 1');
  perform t.eq((select count(*) from inv.v_open_consumption)::int, 0, 'open consumption closed');
  perform t.integrity();
end $$;

-- Reverser justering og overføring
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');
do $$
declare a jsonb; tr jsonb;
begin
  a := inv.create_adjustment('{"reason":"telling","lines":[{"sku":"KNIV-1","delta":-2},{"sku":"KNIV-2","delta":1}]}');
  perform inv.reverse_adjustment((a->>'id')::uuid, 'test');
  perform t.eq(t.on_hand('KNIV-1'), 14.000, 'adj reversed knv1');
  perform t.eq(t.on_hand('KNIV-2'), 1.000, 'adj reversed knv2');
  tr := inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","lines":[{"sku":"KNIV-1","qty":4}]}');
  perform inv.reverse_transfer((tr->>'id')::uuid, 'test');
  perform t.eq(t.on_hand('KNIV-1','MAIN'), 14.000, 'transfer reversed main');
  perform t.eq(t.on_hand('KNIV-1','BUTIKK'), 0.000, 'transfer reversed butikk');
  -- Revaluering og reversering av den
  a := inv.create_adjustment('{"reason":"revaluering","lines":[{"sku":"KNIV-1","revalue_to_unit_cost":90}]}');
  perform t.eq(t.value('KNIV-1'), 1260.00, 'revalued 14*90');
  perform t.eq(jsonb_array_length(a->'movements'), 2, 'two movements');
  perform inv.reverse_adjustment((a->>'id')::uuid, 'test');
  perform t.eq(t.on_hand('KNIV-1'), 14.000, 'revalue reversed qty');
  perform t.integrity();
end $$;

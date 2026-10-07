-- T2: Etter T1: justering +2 uten unit_cost → 120 (on_hand_avg), on_hand 5, value 600
select t.item('KNIV-1');
select t.receive('KNIV-1', 10, 100, '2026-09-01');
select t.receive('KNIV-1', 5, 120, '2026-09-05');
select inv.record_sale('{"ref_id":"S1","lines":[{"sku":"KNIV-1","qty":12}]}');
do $$
declare a jsonb;
begin
  a := inv.create_adjustment('{"reason":"funnet","by":"test","lines":[{"sku":"KNIV-1","delta":2}]}');
  perform t.eq((a->'lines'->0->>'unit_cost')::numeric, 120.0000, 'unit_cost');
  perform t.eq(a->'lines'->0->>'cost_source', 'on_hand_avg', 'cost_source');
  perform t.eq(a->'movements'->0->>'type', 'adjustment_in', 'type');
  perform t.ok((a->>'number') like 'ADJ-%', 'number');
  perform t.eq(t.on_hand('KNIV-1'), 5.000, 'on_hand');
  perform t.eq(t.value('KNIV-1'), 600.00, 'value');
  perform t.integrity();
end $$;
-- preview skriver ingenting
do $$
declare p jsonb; n bigint;
begin
  select count(*) into n from inv.movement;
  p := inv.preview_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-1","delta":3}]}');
  perform t.eq((p->>'preview')::boolean, true, 'preview flag');
  perform t.eq((p->'lines'->0->>'qty_after')::numeric, 8.000, 'preview qty_after');
  perform t.eq((p->'lines'->0->>'unit_cost')::numeric, 120.0000, 'preview cost');
  perform t.eq((select count(*) from inv.movement), n, 'nothing written');
  perform t.eq((select count(*) from inv.adjustment)::int, 1, 'no adjustment written');
  perform t.eq(t.on_hand('KNIV-1'), 5.000, 'unchanged');
end $$;

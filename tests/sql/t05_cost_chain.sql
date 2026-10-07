-- T5: kostkjede: on_hand_avg_all → last_purchase → COST_REQUIRED
insert into inv.location (code, name) values ('BUTIKK', 'Butikk Vulkan');
select t.item('KNIV-1');
select t.item('KNIV-2');
select t.item('KNIV-3');
select t.receive('KNIV-1', 2, 90, '2026-09-01', 'BUTIKK');
do $$
declare a jsonb;
begin
  -- Lag finnes kun på BUTIKK @90
  a := inv.create_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-1","delta":1}]}');
  perform t.eq((a->'lines'->0->>'unit_cost')::numeric, 90.0000, 'avg all');
  perform t.eq(a->'lines'->0->>'cost_source', 'on_hand_avg_all', 'source all');

  -- KNIV-2: kjøpt @95, alt solgt → last_purchase
  perform t.receive('KNIV-2', 1, 95, '2026-09-01');
  perform inv.record_sale('{"ref_id":"S2","lines":[{"sku":"KNIV-2","qty":1}]}');
  a := inv.create_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-2","delta":1}]}');
  perform t.eq((a->'lines'->0->>'unit_cost')::numeric, 95.0000, 'last purchase');
  perform t.eq(a->'lines'->0->>'cost_source', 'last_purchase', 'source last purchase');

  -- KNIV-3: ingen historikk
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-3","delta":1}]}')$q$, 'COST_REQUIRED');
  -- med oppgitt kost går det
  a := inv.create_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-3","delta":1,"unit_cost":50}]}');
  perform t.eq(a->'lines'->0->>'cost_source', 'manual', 'manual');
  perform t.integrity();
end $$;

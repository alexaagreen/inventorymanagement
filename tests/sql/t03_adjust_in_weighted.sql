-- T3: Lag 3@100 og 1@140. Justering +2 uten kost → (300+140)/4 = 110
select t.item('KNIV-1');
select t.receive('KNIV-1', 3, 100, '2026-09-01');
select t.receive('KNIV-1', 1, 140, '2026-09-02');
do $$
declare a jsonb;
begin
  a := inv.create_adjustment('{"reason":"funnet","lines":[{"sku":"KNIV-1","delta":2}]}');
  perform t.eq((a->'lines'->0->>'unit_cost')::numeric, 110.0000, 'weighted avg');
  perform t.eq(a->'lines'->0->>'cost_source', 'on_hand_avg', 'source');
  perform t.eq(t.value('KNIV-1'), 660.00, 'value 300+140+220');
  perform t.integrity();
end $$;

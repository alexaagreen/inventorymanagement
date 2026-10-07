-- T1: Mottak 10@100, mottak 5@120, salg 12 → COGS 1240, unit 103.3333, on_hand 3, value 360, avg 120
select t.item('KNIV-1');
select t.receive('KNIV-1', 10, 100, '2026-09-01');
select t.receive('KNIV-1', 5, 120, '2026-09-05');
do $$
declare r jsonb; m jsonb;
begin
  r := inv.record_sale('{"ref_id":"S1","lines":[{"sku":"KNIV-1","qty":12}]}');
  m := r->'movements'->0;
  perform t.eq((m->>'total_cost')::numeric, 1240.00, 'COGS');
  perform t.eq((m->>'unit_cost')::numeric, 103.3333, 'unit cost');
  perform t.eq(jsonb_array_length(m->'consumptions'), 2, 'two consumptions');
  perform t.eq((m->'consumptions'->0->>'qty')::numeric, 10.000, 'first layer qty');
  perform t.eq((m->'consumptions'->1->>'unit_cost')::numeric, 120.0000, 'second layer cost');
  perform t.eq((m->>'on_hand_after')::numeric, 3.000, 'on_hand_after');
  perform t.eq(t.on_hand('KNIV-1'), 3.000, 'on_hand');
  perform t.eq(t.value('KNIV-1'), 360.00, 'value');
  perform t.eq((select avg_cost from inv.v_item_status where sku='KNIV-1'), 120.0000, 'avg_cost');
  perform t.integrity();
end $$;

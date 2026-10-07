-- T7: on_hand 0, siste kjøp @120. Salg 2 → −2 estimert 240. Mottak 10@130 dekker → 260, korreksjon +20
select t.item('KNIV-1');
select t.receive('KNIV-1', 1, 120, '2026-09-01');
select inv.record_sale('{"ref_id":"S0","lines":[{"sku":"KNIV-1","qty":1}]}');
do $$
declare r jsonb; m jsonb; v_sale bigint;
begin
  r := inv.record_sale('{"ref_id":"S1","lines":[{"sku":"KNIV-1","qty":2}]}');
  m := r->'movements'->0;
  v_sale := (m->>'id')::bigint;
  perform t.eq((m->>'cost_estimated')::boolean, true, 'estimated');
  perform t.eq((m->>'total_cost')::numeric, 240.00, 'estimated total');
  perform t.eq(m->>'cost_source', 'last_purchase', 'estimate source');
  perform t.ok((m->'consumptions'->0->>'layer_id') is null, 'uncovered consumption');
  perform t.eq(t.on_hand('KNIV-1'), -2.000, 'negative on_hand');
  perform t.eq(t.value('KNIV-1'), 0.00, 'value 0 while negative');
  perform t.eq((select open_consumption_qty from inv.v_item_status where sku='KNIV-1'), 2.000, 'open qty');
  perform t.integrity();

  perform t.receive('KNIV-1', 10, 130, '2026-09-10');
  select jsonb_build_object('total_cost', total_cost, 'cost_estimated', cost_estimated, 'unit_cost', unit_cost, 'cost_source', cost_source)
    into m from inv.movement where id = v_sale;
  perform t.eq((m->>'total_cost')::numeric, 260.00, 'actual total');
  perform t.eq((m->>'cost_estimated')::boolean, false, 'no longer estimated');
  perform t.eq(m->>'cost_source', 'fifo', 'source fifo');
  perform t.eq((select sum(delta_cost) from inv.cogs_correction where movement_id = v_sale), 20.00, 'cogs correction');
  perform t.eq(t.on_hand('KNIV-1'), 8.000, 'on_hand 8');
  perform t.eq((select qty_remaining from inv.cost_layer order by id desc limit 1), 8.000, 'layer remaining 8');
  perform t.eq(t.value('KNIV-1'), 1040.00, 'value 8*130');
  perform t.eq((select count(*) from inv.v_open_consumption)::int, 0, 'no open consumption');
  perform t.integrity();
end $$;

-- Delvis dekking: salg 5 på 0, mottak 3 → 3 dekket, 2 fortsatt åpent
select t.item('KNIV-2');
select t.receive('KNIV-2', 1, 100, '2026-09-01');
select inv.record_sale('{"ref_id":"P0","lines":[{"sku":"KNIV-2","qty":1}]}');
do $$
declare v_sale bigint;
begin
  v_sale := (inv.record_sale('{"ref_id":"P1","lines":[{"sku":"KNIV-2","qty":5}]}')->'movements'->0->>'id')::bigint;
  perform t.receive('KNIV-2', 3, 110, '2026-09-10');
  perform t.eq(t.on_hand('KNIV-2'), -2.000, 'still -2');
  perform t.eq((select cost_estimated from inv.movement where id = v_sale), true, 'still estimated');
  perform t.eq((select total_cost from inv.movement where id = v_sale), 530.00, '3*110 + 2*100');
  perform t.eq((select count(*) from inv.layer_consumption where movement_id = v_sale)::int, 2, 'split rows');
  perform t.integrity();
  perform t.receive('KNIV-2', 4, 120, '2026-09-11');
  perform t.eq((select total_cost from inv.movement where id = v_sale), 570.00, '3*110 + 2*120');
  perform t.eq((select cost_estimated from inv.movement where id = v_sale), false, 'fully covered');
  perform t.eq(t.on_hand('KNIV-2'), 2.000, 'on_hand 2');
  perform t.integrity();
end $$;

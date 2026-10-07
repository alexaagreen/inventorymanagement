-- T12: Overføring 4 fra MAIN (3@100 1.9, 2@140 5.9) til BUTIKK; salg 1 på BUTIKK → COGS 100
insert into inv.location (code, name) values ('BUTIKK', 'Butikk Vulkan');
select t.item('KNIV-1');
select t.receive('KNIV-1', 3, 100, '2026-09-01');
select t.receive('KNIV-1', 2, 140, '2026-09-05');
do $$
declare tr jsonb; s jsonb;
begin
  tr := inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","by":"test","lines":[{"sku":"KNIV-1","qty":4}]}');
  perform t.ok((tr->>'number') like 'TR-%', 'number');
  perform t.eq(t.on_hand('KNIV-1','MAIN'), 1.000, 'main 1');
  perform t.eq(t.value('KNIV-1','MAIN'), 140.00, 'main value');
  perform t.eq(t.on_hand('KNIV-1','BUTIKK'), 4.000, 'butikk 4');
  perform t.eq(t.value('KNIV-1','BUTIKK'), 440.00, 'butikk value');
  perform t.eq((select count(*) from inv.cost_layer cl join inv.location l on l.id=cl.location_id where l.code='BUTIKK')::int, 2, 'two layers at dest');
  perform t.eq((select min(received_at) from inv.cost_layer cl join inv.location l on l.id=cl.location_id where l.code='BUTIKK'),
               '2026-09-01'::timestamptz, 'received_at preserved');
  s := inv.record_sale('{"ref_id":"S1","location":"BUTIKK","lines":[{"sku":"KNIV-1","qty":1}]}');
  perform t.eq((s->'movements'->0->>'total_cost')::numeric, 100.00, 'FIFO at dest uses oldest');
  -- v_item_status summerer lokasjoner
  perform t.eq((select on_hand from inv.v_item_status where sku='KNIV-1'), 4.000, 'total on_hand');
  perform t.integrity();
end $$;

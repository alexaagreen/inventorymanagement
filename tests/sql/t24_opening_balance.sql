-- M6: åpningsbalanse — dry run, alt-eller-ingenting, idempotent
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');
select t.item('A'); select t.item('B');
do $$
declare r jsonb;
begin
  r := inv.import_opening_balance('{"dry_run": true, "rows": [{"sku":"A","qty":10,"unit_cost":50},{"sku":"B","location":"BUTIKK","qty":2,"unit_cost":"12.5"}]}');
  perform t.eq((r->>'ok')::boolean, true, 'dry run ok');
  perform t.eq((r->>'total_value')::numeric, 525.00, 'total value');
  perform t.eq((select count(*) from inv.movement)::int, 0, 'dry run writes nothing');

  r := inv.import_opening_balance('{"rows": [{"sku":"A","qty":10,"unit_cost":50},{"sku":"NOPE","qty":1,"unit_cost":1},{"sku":"B","qty":0,"unit_cost":1}]}');
  perform t.eq((r->>'ok')::boolean, false, 'errors reported');
  perform t.eq(jsonb_array_length(r->'errors'), 2, 'two errors');
  perform t.eq((r->'errors'->0->>'row')::int, 2, 'row number');
  perform t.eq((select count(*) from inv.movement)::int, 0, 'nothing written on error');

  r := inv.import_opening_balance('{"rows": [{"sku":"A","qty":1,"unit_cost":1},{"sku":"a","qty":2,"unit_cost":1}]}');
  perform t.eq((r->'errors'->0->>'message') like 'duplicate row%', true, 'duplicate detected');

  r := inv.import_opening_balance('{"by":"test","rows": [{"sku":"A","qty":10,"unit_cost":50},{"sku":"B","location":"BUTIKK","qty":2,"unit_cost":12.5}]}');
  perform t.eq((r->>'imported')::int, 2, 'imported 2');
  perform t.eq(t.on_hand('A'), 10.000, 'A on hand');
  perform t.eq(t.value('B', 'BUTIKK'), 25.00, 'B value');
  perform t.eq((select type::text from inv.movement where ref_id = 'A:MAIN'), 'opening_balance', 'type');

  r := inv.import_opening_balance('{"rows": [{"sku":"A","qty":99,"unit_cost":1}]}');
  perform t.eq((r->>'existing')::int, 1, 'second import skipped');
  perform t.eq(t.on_hand('A'), 10.000, 'unchanged');

  -- Empty unit_cost: no history → 0 / unknown. Decimal comma and explicit 0 stay manual.
  perform t.item('C'); perform t.item('D'); perform t.item('E'); perform t.item('F');
  r := inv.import_opening_balance('{"dry_run": true, "rows": [{"sku":"C","qty":4},{"sku":"D","qty":"2,5","unit_cost":"10,5"},{"sku":"E","qty":1,"unit_cost":0},{"sku":"F","qty":1,"unit_cost":"1.234,56"}]}');
  perform t.eq((r->>'ok')::boolean, true, 'empty cost dry run ok');
  perform t.eq(r->'rows'->0->>'cost_source', 'unknown', 'preview unknown cost');
  perform t.eq((r->'rows'->0->>'unit_cost')::numeric, 0.00, 'preview zero cost');
  perform t.eq((r->'rows'->1->>'unit_cost')::numeric, 10.5, 'decimal comma cost');
  perform t.eq((r->'rows'->1->>'qty')::numeric, 2.5, 'decimal comma qty');
  perform t.eq((r->'rows'->3->>'unit_cost')::numeric, 1234.56, 'nb-NO thousands');
  perform t.eq((select count(*) from inv.movement)::int, 2, 'dry run still writes nothing');

  r := inv.import_opening_balance('{"rows": [{"sku":"C","qty":4,"unit_cost":""},{"sku":"D","qty":"2,5","unit_cost":"10,5"},{"sku":"E","qty":1,"unit_cost":0},{"sku":"F","qty":1,"unit_cost":"1.234,56"},{"sku":"A","location":"BUTIKK","qty":2}]}');
  perform t.eq((r->>'ok')::boolean, true, 'empty cost imported');
  perform t.eq((r->>'imported')::int, 5, 'imported empty and comma rows');
  perform t.eq(t.on_hand('C'), 4.000, 'C on hand');
  perform t.eq(t.value('C'), 0.00, 'C value is zero');
  perform t.eq((select cost_source from inv.movement where ref_id = 'C:MAIN'), 'unknown', 'C cost source');
  perform t.eq((select unit_cost from inv.movement where ref_id = 'C:MAIN'), 0.00, 'C unit cost 0');
  perform t.eq((select reference from inv.movement where ref_id = 'C:MAIN'), 'Opening balance', 'opening reference');
  perform t.eq(t.on_hand('D'), 2.500, 'D on hand');
  perform t.eq(t.value('D'), 26.25, 'D value');
  perform t.eq((select cost_source from inv.movement where ref_id = 'E:MAIN'), 'manual', 'explicit zero is manual');
  perform t.eq(t.value('F'), 1234.56, 'F thousands value');
  perform t.eq((select cost_source from inv.movement where ref_id = 'A:BUTIKK'), 'on_hand_avg_all', 'empty cost uses stock elsewhere');
  perform t.eq(t.value('A', 'BUTIKK'), 100.00, 'A at BUTIKK uses average 50');

  r := inv.import_opening_balance('{"rows": [{"sku":"C","qty":1,"unit_cost":-1}]}');
  perform t.eq((r->>'ok')::boolean, false, 'negative cost rejected');
  perform t.eq(t.on_hand('C'), 4.000, 'negative cost wrote nothing');

  perform t.integrity();
end $$;

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
  perform t.integrity();
end $$;

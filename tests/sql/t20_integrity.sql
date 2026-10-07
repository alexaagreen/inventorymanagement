-- T20: verify_integrity etter en blandet sekvens + immutabilitet + rebuild
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');
select t.item('A'); select t.item('B');
select t.receive('A', 10, 100, '2026-09-01');
select t.receive('B', 2, 50, '2026-09-01');
select inv.record_sale('{"ref_id":"X1","lines":[{"sku":"A","qty":3},{"sku":"B","qty":5}]}');
select inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","lines":[{"sku":"A","qty":2}]}');
select inv.create_adjustment('{"reason":"telling","location":"BUTIKK","lines":[{"sku":"A","new_qty":1}]}');
select t.receive('B', 1, 60, '2026-09-10');
select inv.record_sale_return('{"ref_id":"R1","original_ref_id":"X1","lines":[{"sku":"A","qty":1}]}');
select inv.post_movement('{"sku":"A","type":"opening_balance","qty":2,"unit_cost":70,"location":"BUTIKK","ref_type":"opening_balance","ref_id":"A:BUTIKK"}');
do $$
declare v jsonb;
begin
  perform t.integrity();
  perform t.eq(t.on_hand('B'), -2.000, 'B negative');
  -- idempotens på ref
  v := inv.post_movement('{"sku":"A","type":"opening_balance","qty":2,"unit_cost":70,"location":"BUTIKK","ref_type":"opening_balance","ref_id":"A:BUTIKK"}');
  perform t.eq((v->>'existing')::boolean, true, 'idempotent');
  perform t.expect_error($q$select inv.post_movement('{"sku":"A","type":"opening_balance","qty":2,"unit_cost":70,"ref_type":"opening_balance","ref_id":"A:BUTIKK","on_conflict":"error"}')$q$, 'DUPLICATE_REF');
  perform t.expect_error($q$select inv.post_movement('{"sku":"A","type":"sale","qty":2}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.post_movement('{"sku":"A","type":"reversal","qty":-2}')$q$, 'VALIDATION');
  -- retur bruker salgets COGS
  perform t.eq((select unit_cost from inv.movement where ref_type='manual_return' and ref_id='R1'), 100.0000, 'return at sale cogs');
  -- immutabilitet
  perform t.expect_error('delete from inv.movement where id = 1', 'IMMUTABLE');
  perform t.expect_error('update inv.movement set qty = 5 where id = 1', 'IMMUTABLE');
  perform t.expect_error('update inv.movement set on_hand_after = 99 where id = 1', 'IMMUTABLE');
  -- rebuild gir samme saldo
  update inv.stock_balance set on_hand = 999;
  perform inv.rebuild_balances();
  perform t.integrity();
end $$;

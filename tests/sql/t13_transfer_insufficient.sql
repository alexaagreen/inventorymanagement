-- T13: Overføring 5 når MAIN har 4 → INSUFFICIENT_STOCK
insert into inv.location (code, name) values ('BUTIKK', 'Butikk Vulkan');
select t.item('KNIV-1');
select t.receive('KNIV-1', 4, 100);
do $$
begin
  perform t.expect_error($q$select inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","lines":[{"sku":"KNIV-1","qty":5}]}')$q$, 'INSUFFICIENT_STOCK');
  perform t.expect_error($q$select inv.create_transfer('{"from_location":"MAIN","to_location":"MAIN","lines":[{"sku":"KNIV-1","qty":1}]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_transfer('{"from_location":"MAIN","to_location":"NOPE","lines":[{"sku":"KNIV-1","qty":1}]}')$q$, 'LOCATION_NOT_FOUND');
  perform t.eq((select count(*) from inv.transfer)::int, 0, 'no transfer');
  perform t.eq(t.on_hand('KNIV-1'), 4.000, 'unchanged');
  perform t.integrity();
end $$;

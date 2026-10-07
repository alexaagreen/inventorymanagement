-- T6: Justering −5 når on_hand 3 → INSUFFICIENT_STOCK, ingenting skrevet
select t.item('KNIV-1');
select t.receive('KNIV-1', 3, 100);
do $$
declare n_before bigint; n_adj bigint;
begin
  select count(*) into n_before from inv.movement;
  select count(*) into n_adj from inv.adjustment;
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"x","lines":[{"sku":"KNIV-1","delta":-5}]}')$q$, 'INSUFFICIENT_STOCK');
  perform t.eq((select count(*) from inv.movement), n_before, 'no movement written');
  perform t.eq((select count(*) from inv.adjustment), n_adj, 'no adjustment written');
  perform t.eq(t.on_hand('KNIV-1'), 3.000, 'on_hand unchanged');
  perform t.integrity();
end $$;

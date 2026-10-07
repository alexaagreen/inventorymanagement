-- T4: Lag 3@100, 1@140. new_qty 1 → delta −3, konsumerer 3@100, igjen 1@140
select t.item('KNIV-1');
select t.receive('KNIV-1', 3, 100, '2026-09-01');
select t.receive('KNIV-1', 1, 140, '2026-09-02');
do $$
declare a jsonb;
begin
  a := inv.create_adjustment('{"reason":"telling","lines":[{"sku":"KNIV-1","new_qty":1}]}');
  perform t.eq((a->'lines'->0->>'qty_delta')::numeric, -3.000, 'delta');
  perform t.eq((a->'lines'->0->>'qty_before')::numeric, 4.000, 'before');
  perform t.eq((a->'movements'->0->>'total_cost')::numeric, 300.00, 'total cost');
  perform t.eq(a->'movements'->0->>'type', 'adjustment_out', 'type');
  perform t.eq(t.on_hand('KNIV-1'), 1.000, 'on_hand');
  perform t.eq(t.value('KNIV-1'), 140.00, 'value');
  -- new_qty lik dagens → ingen bevegelse
  a := inv.create_adjustment('{"reason":"telling","lines":[{"sku":"KNIV-1","new_qty":1}]}');
  perform t.ok((a->'lines'->0->>'movement_id') is null, 'no movement when delta 0');
  perform t.eq(jsonb_array_length(a->'movements'), 0, 'no movements');
  -- write_off
  a := inv.create_adjustment('{"reason":"knust","write_off":true,"lines":[{"sku":"KNIV-1","delta":-1}]}');
  perform t.eq(a->'movements'->0->>'type', 'write_off', 'write_off type');
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"x","write_off":true,"lines":[{"sku":"KNIV-1","delta":1,"unit_cost":5}]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"x","lines":[{"sku":"KNIV-1","delta":1,"new_qty":2}]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"x","lines":[{"sku":"KNIV-1","new_qty":-1}]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_adjustment('{"lines":[{"sku":"KNIV-1","delta":1}]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_adjustment('{"reason":"x","lines":[{"sku":"NOPE","delta":1}]}')$q$, 'ITEM_NOT_FOUND');
  perform t.integrity();
end $$;

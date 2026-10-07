-- T9: Ordre cancelled → sale_return med salgets COGS, restored. Nytt cancelled → ingenting.
select t.item('KNIV-1', 101);
select t.receive('KNIV-1', 2, 100, '2026-09-01');
select t.receive('KNIV-1', 5, 120, '2026-09-05');
do $$
declare r jsonb;
begin
  r := inv.apply_woo_order('{"id":1,"status":"processing","line_items":[{"id":11,"product_id":101,"quantity":3}]}', 'webhook');
  perform t.eq((r->'movements'->0->>'total_cost')::numeric, 320.00, '2*100+1*120');
  r := inv.apply_woo_order('{"id":1,"status":"cancelled","line_items":[{"id":11,"product_id":101,"quantity":3}]}', 'webhook');
  perform t.eq(r->>'action', 'restored', 'restored');
  perform t.eq(r->'movements'->0->>'type', 'sale_return', 'type');
  perform t.eq((r->'movements'->0->>'qty')::numeric, 3.000, 'qty 3');
  perform t.eq((r->'movements'->0->>'unit_cost')::numeric, 106.6667, 'unit cost = sale cogs');
  perform t.eq(r->'movements'->0->>'ref_line', '11:r1', 'ref_line');
  perform t.eq(t.on_hand('KNIV-1'), 7.000, 'back to 7');
  r := inv.apply_woo_order('{"id":1,"status":"cancelled","line_items":[{"id":11,"product_id":101,"quantity":3}]}', 'webhook');
  perform t.eq(r->>'action', 'ignored', 'second cancel ignored');
  perform t.eq(jsonb_array_length(r->'movements'), 0, 'none');
  -- gjenåpnet
  r := inv.apply_woo_order('{"id":1,"status":"processing","line_items":[{"id":11,"product_id":101,"quantity":3}]}', 'webhook');
  perform t.eq(r->>'action', 'deducted', 'reopened');
  perform t.eq(r->'movements'->0->>'ref_line', '11:2', 'new ref_line suffix');
  perform t.eq(t.on_hand('KNIV-1'), 4.000, 'deducted again');
  perform t.integrity();
end $$;

-- T10: deducted qty 2 → updated qty 3 → sale −1 (ref 'line:1'). Så qty 1 → sale_return +2. Linje fjernet → retur.
select t.item('KNIV-1', 101); select t.item('KNIV-2', 102);
select t.receive('KNIV-1', 10, 100); select t.receive('KNIV-2', 10, 50);
do $$
declare r jsonb;
begin
  perform inv.apply_woo_order('{"id":7,"status":"processing","line_items":[{"id":70,"product_id":101,"quantity":2},{"id":71,"product_id":102,"quantity":1}]}', 'webhook');
  r := inv.apply_woo_order('{"id":7,"status":"processing","line_items":[{"id":70,"product_id":101,"quantity":3},{"id":71,"product_id":102,"quantity":1}]}', 'webhook');
  perform t.eq(r->>'action', 'adjusted', 'adjusted');
  perform t.eq(jsonb_array_length(r->'movements'), 1, 'one movement');
  perform t.eq((r->'movements'->0->>'qty')::numeric, -1.000, 'sale -1');
  perform t.eq(r->'movements'->0->>'ref_line', '70:1', 'ref_line suffix');
  r := inv.apply_woo_order('{"id":7,"status":"on-hold","line_items":[{"id":70,"product_id":101,"quantity":1}]}', 'webhook');
  perform t.eq(jsonb_array_length(r->'movements'), 2, 'two returns (reduced + removed line)');
  perform t.eq(t.on_hand('KNIV-1'), 9.000, 'knv1 9');
  perform t.eq(t.on_hand('KNIV-2'), 10.000, 'knv2 back to 10');
  perform t.eq((select jsonb_agg((x->>'net')::numeric order by x->>'line_id') from inv.woo_order_sync, jsonb_array_elements(lines) x where woo_order_id = 7),
               '[1, 0]'::jsonb, 'net per line');
  perform t.integrity();
end $$;

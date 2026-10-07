-- T11: Refund −1 på ordre som har trukket 2 → +1. Samme refund igjen → ignored. Refund 5 når 1 igjen → +1.
select t.item('KNIV-1', 101);
select t.receive('KNIV-1', 10, 100);
do $$
declare r jsonb;
begin
  perform inv.apply_woo_order('{"id":9,"status":"processing","line_items":[{"id":90,"product_id":101,"quantity":2}]}', 'webhook');
  r := inv.apply_woo_refund(9, '{"id":500,"line_items":[{"id":5001,"product_id":101,"quantity":-1,"meta_data":[{"key":"_refunded_item_id","value":"90"}]}]}');
  perform t.eq(r->>'action', 'applied', 'applied');
  perform t.eq(r->'movements'->0->>'ref_type', 'woo_refund', 'ref_type');
  perform t.eq((r->'movements'->0->>'unit_cost')::numeric, 100.0000, 'cogs');
  perform t.eq(t.on_hand('KNIV-1'), 9.000, '9');
  r := inv.apply_woo_refund(9, '{"id":500,"line_items":[{"id":5001,"product_id":101,"quantity":-1,"meta_data":[{"key":"_refunded_item_id","value":"90"}]}]}');
  perform t.eq(r->>'action', 'ignored', 'same refund ignored');
  r := inv.apply_woo_refund(9, '{"id":501,"line_items":[{"id":5002,"product_id":101,"quantity":-5}]}');
  perform t.eq((r->'movements'->0->>'qty')::numeric, 1.000, 'capped at net');
  perform t.eq(t.on_hand('KNIV-1'), 10.000, '10');
  -- Beløpsrefusjon uten varelinjer
  r := inv.apply_woo_refund(9, '{"id":502,"line_items":[]}');
  perform t.eq(r->>'action', 'ignored', 'amount-only refund ignored');
  -- Full refund etterfulgt av status refunded → ingen dobbel retur
  r := inv.apply_woo_order('{"id":9,"status":"refunded","line_items":[{"id":90,"product_id":101,"quantity":2}]}', 'webhook');
  perform t.eq(jsonb_array_length(r->'movements'), 0, 'nothing left to return');
  perform t.eq(t.on_hand('KNIV-1'), 10.000, 'still 10');
  -- Ukjent ordre
  r := inv.apply_woo_refund(424242, '{"id":1,"line_items":[]}');
  perform t.eq(r->>'action', 'ignored', 'unknown order ignored');
  perform t.integrity();
end $$;

-- Refusjon før ordren er trukket, så processing → trekk bare resten
select t.item('KNIV-2', 102);
select t.receive('KNIV-2', 10, 50);
do $$
begin
  perform inv.apply_woo_order('{"id":10,"status":"pending","line_items":[{"id":100,"product_id":102,"quantity":3}]}', 'webhook');
  perform inv.apply_woo_refund(10, '{"id":600,"line_items":[{"id":6001,"product_id":102,"quantity":-1,"meta_data":[{"key":"_refunded_item_id","value":"100"}]}]}');
  perform t.eq(t.on_hand('KNIV-2'), 10.000, 'nothing returned before deduct');
end $$;

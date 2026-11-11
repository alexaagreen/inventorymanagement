-- T33: margin per sale — cost per order line and tracing back to the purchase (spec §6.9)
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');

-- 1) Sale of 3 over two layers (2 @ 100, 1 @ 120) → two source rows with the right receipt/PO; cogs 320
select t.item('KNIV-1', 101);
select t.receive('KNIV-1', 2, 100, '2026-09-01');
select t.receive('KNIV-1', 5, 120, '2026-09-05');
do $$
declare r record;
begin
  perform inv.apply_woo_order('{"id":1,"number":"1001","status":"processing","date_created_gmt":"2026-09-10T10:00:00","line_items":[{"id":11,"product_id":101,"quantity":3}]}', 'webhook');
  select * into r from inv.v_sale_line_cost where source = 'woo_order' and order_id = '1' and line_id = '11';
  perform t.eq(r.qty_sold, 3.000, 'qty sold');
  perform t.eq(r.qty_net, 3.000, 'qty net');
  perform t.eq(r.cogs, 320.00, 'cogs 2*100 + 1*120');
  perform t.eq(r.unit_cogs, 106.6667, 'unit cogs');
  perform t.eq(r.cost_estimated, false, 'not estimated');
  perform t.eq(r.sku, 'KNIV-1', 'sku');
  perform t.eq(r.order_ref, '#1001', 'order ref');
  perform t.eq((select count(*) from inv.v_sale_cost_source where order_id = '1')::int, 2, 'two source rows');
  perform t.eq((select count(distinct receipt_id) from inv.v_sale_cost_source where order_id = '1')::int, 2, 'two receipts');
  perform t.ok((select bool_and(origin = 'purchase' and po_number like 'PO-%' and supplier_name = 'Test' and line_id = '11')
                  from inv.v_sale_cost_source where order_id = '1'), 'origin purchase with PO and supplier');
  perform t.eq((select sum(cost) from inv.v_sale_cost_source where order_id = '1'), 320.00, 'sources add up to cogs');
  perform t.eq((select po_unit_cost from inv.v_sale_cost_source where order_id = '1' order by received_at limit 1), 100.0000, 'po price of oldest layer');
end $$;

-- 2) Line raised 1 → 3, then lowered to 2 → still one row, qty_net 2
select t.item('KNIV-2', 102);
select t.receive('KNIV-2', 10, 50, '2026-09-01');
do $$
declare r record;
begin
  perform inv.apply_woo_order('{"id":2,"status":"processing","line_items":[{"id":21,"product_id":102,"quantity":1}]}', 'webhook');
  perform inv.apply_woo_order('{"id":2,"status":"processing","line_items":[{"id":21,"product_id":102,"quantity":3}]}', 'webhook');
  perform inv.apply_woo_order('{"id":2,"status":"processing","line_items":[{"id":21,"product_id":102,"quantity":2}]}', 'webhook');
  perform t.eq((select count(*) from inv.v_sale_line_cost where order_id = '2')::int, 1, 'one row per order line');
  select * into r from inv.v_sale_line_cost where order_id = '2';
  perform t.eq(r.line_id, '21', 'line id without suffix');
  perform t.eq(r.qty_sold, 3.000, 'sold 3');
  perform t.eq(r.qty_returned, 1.000, 'returned 1');
  perform t.eq(r.qty_net, 2.000, 'net 2');
  perform t.eq(r.cogs, 100.00, 'net cogs 2*50');

  -- 3) Refund of 1 → lands on the original order line
  perform inv.apply_woo_refund(2, '{"id":700,"line_items":[{"id":7001,"product_id":102,"quantity":-1,"meta_data":[{"key":"_refunded_item_id","value":"21"}]}]}');
  perform t.eq((select count(*) from inv.v_sale_line_cost where order_id = '2')::int, 1, 'refund is on the same row');
  select * into r from inv.v_sale_line_cost where order_id = '2';
  perform t.eq(r.qty_returned, 2.000, 'returned 2');
  perform t.eq(r.qty_net, 1.000, 'net 1');
  perform t.eq(r.cogs, 50.00, 'net cogs 50');
end $$;

-- 4) Sale on negative stock, later receipt at another price → estimated → purchase
select t.item('KNIV-3', 103);
select t.receive('KNIV-3', 1, 100, '2026-09-01');
select inv.record_sale('{"ref_id":"M0","lines":[{"sku":"KNIV-3","qty":1}]}');
do $$
declare r record;
begin
  perform inv.apply_woo_order('{"id":3,"status":"processing","line_items":[{"id":31,"product_id":103,"quantity":2}]}', 'webhook');
  select * into r from inv.v_sale_line_cost where order_id = '3';
  perform t.eq(r.cost_estimated, true, 'estimated while uncovered');
  perform t.eq(r.cogs, 200.00, 'estimated cogs');
  perform t.ok(r.last_cost_change_at is null, 'no cost change yet');
  perform t.eq((select origin from inv.v_sale_cost_source where order_id = '3'), 'estimated', 'origin estimated');
  perform t.receive('KNIV-3', 5, 130, '2026-09-20');
  select * into r from inv.v_sale_line_cost where order_id = '3';
  perform t.eq(r.cost_estimated, false, 'covered');
  perform t.eq(r.cogs, 260.00, 'actual cogs');
  perform t.ok(r.last_cost_change_at is not null, 'cost change logged');
  perform t.eq((select origin from inv.v_sale_cost_source where order_id = '3'), 'purchase', 'origin purchase after cover');
end $$;

-- 5) Receipt on MAIN, transfer to BUTIKK, sale from BUTIKK → traced to the original receipt
select t.item('KNIV-4', 104);
do $$
declare gr jsonb; r record;
begin
  gr := t.receive('KNIV-4', 4, 200, '2026-09-01');
  perform inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","by":"test","lines":[{"sku":"KNIV-4","qty":3}]}');
  perform inv.record_sale('{"ref_id":"B1","location":"BUTIKK","lines":[{"sku":"KNIV-4","qty":1,"ref_line":"L1"}]}');
  select * into r from inv.v_sale_cost_source where source = 'manual_sale' and order_id = 'B1';
  perform t.eq(r.origin, 'purchase', 'origin through transfer');
  perform t.eq(r.receipt_number, gr->>'number', 'original receipt');
  perform t.eq(r.location, 'BUTIKK', 'sold from BUTIKK');
  perform t.ok(r.layer_id <> r.root_layer_id, 'root layer is the one on MAIN');
  perform t.eq(r.received_at, '2026-09-01'::timestamptz, 'received_at of the root');
  perform t.eq((select line_id from inv.v_sale_line_cost where order_id = 'B1'), 'L1', 'manual line id');

  -- Manual return finds its sale (also without original_ref_line)
  perform inv.record_sale_return('{"ref_id":"R1","original_ref_id":"B1","location":"BUTIKK","lines":[{"sku":"KNIV-4","qty":1}]}');
  perform t.eq((select count(*) from inv.v_sale_line_cost where order_id = 'B1')::int, 1, 'return on the sale row');
  perform t.eq((select qty_net from inv.v_sale_line_cost where order_id = 'B1'), 0.000, 'net 0');
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = 'B1'), 0.00, 'cogs 0');
  perform t.ok((select unit_cogs from inv.v_sale_line_cost where order_id = 'B1') is null, 'no unit cogs at net 0');
end $$;

-- 6) Reversed sale → no row. Opening balance → own origin.
select t.item('KNIV-5', 105);
select inv.import_opening_balance('{"by":"test","rows":[{"sku":"KNIV-5","qty":5,"unit_cost":80}]}');
do $$
declare v_id bigint;
begin
  v_id := (inv.record_sale('{"ref_id":"X1","lines":[{"sku":"KNIV-5","qty":2}]}')->'movements'->0->>'id')::bigint;
  perform t.eq((select origin from inv.v_sale_cost_source where order_id = 'X1'), 'opening_balance', 'origin opening balance');
  perform t.ok((select receipt_id from inv.v_sale_cost_source where order_id = 'X1') is null, 'no receipt behind an opening balance');
  perform inv.reverse_movement(v_id, 'test', 'feil');
  perform t.eq((select count(*) from inv.v_sale_line_cost where order_id = 'X1')::int, 0, 'reversed sale has no row');
  perform t.eq((select count(*) from inv.v_sale_cost_source where order_id = 'X1')::int, 0, 'reversed sale has no sources');
end $$;

-- 7) Σ cogs per order line = the ledger's COGS (sale − sale_return, not reversed)
do $$
begin
  perform t.eq((select sum(cogs) from inv.v_sale_line_cost),
               (select round(sum(case when type = 'sale' then total_cost else -total_cost end), 2)
                  from inv.movement where type in ('sale','sale_return') and reversed_by is null),
               'line costs add up to total COGS');
  perform t.integrity();
end $$;

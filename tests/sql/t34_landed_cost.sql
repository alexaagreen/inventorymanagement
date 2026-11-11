-- T34: landed cost allocation — freight/duty invoiced after receipt follows the units (spec §6.10)
insert into inv.location (code, name) values ('BUTIKK', 'Butikk');

-- A) By value over a receipt with two lines. A: 10 @ 100, B: 5 @ 400 → goods value 3000.
--    Before the freight invoice: A sold 3 (Woo), 4 moved to BUTIKK and 1 sold there, 1 written off.
--    Freight 300 → A +10/unit, B +40/unit. A: 5 in stock, 4 sold, 1 written off.
select t.item('LC-A', 201);
select t.item('LC-B', 202);
do $$
declare
  po jsonb; gr jsonb; lc jsonb; pv jsonb; v_po uuid; v_gr uuid; v_lc uuid;
  v_woff bigint; v_tout bigint; v_tin bigint; a jsonb; tr jsonb; v_cnt int;
begin
  po := inv.create_purchase_order('{"supplier_name":"Tojiro","lines":[{"sku":"LC-A","qty":10,"unit_cost":100},{"sku":"LC-B","qty":5,"unit_cost":400}]}');
  v_po := (po->>'id')::uuid;
  perform inv.set_purchase_order_status(v_po, 'sent', 'test');
  gr := inv.receive_purchase_order(v_po, '{"by":"test","received_at":"2026-09-01","lines":[{"sku":"LC-A","qty":10},{"sku":"LC-B","qty":5}]}');
  v_gr := (gr->>'id')::uuid;

  perform inv.apply_woo_order('{"id":50,"status":"processing","line_items":[{"id":501,"product_id":201,"quantity":3}]}', 'webhook');
  tr := inv.create_transfer('{"from_location":"MAIN","to_location":"BUTIKK","by":"test","lines":[{"sku":"LC-A","qty":4}]}');
  v_tout := (tr->'lines'->0->>'out_movement_id')::bigint;
  v_tin  := (tr->'lines'->0->>'in_movement_id')::bigint;
  perform inv.record_sale('{"ref_id":"POS-1","location":"BUTIKK","lines":[{"sku":"LC-A","qty":1}]}');
  a := inv.create_adjustment('{"reason":"knust","write_off":true,"lines":[{"sku":"LC-A","delta":-1}]}');
  v_woff := (a->'lines'->0->>'movement_id')::bigint;

  -- Preview writes nothing
  select count(*) into v_cnt from inv.landed_cost;
  pv := inv.preview_landed_cost(jsonb_build_object('amount', 300, 'receipts', jsonb_build_array(gr->>'number'), 'by', 'test'));
  perform t.eq((pv->>'preview')::boolean, true, 'preview flag');
  perform t.eq((pv->>'to_cogs')::numeric, 40.00, 'preview shows the split');
  perform t.eq((select count(*) from inv.landed_cost)::int, v_cnt, 'preview stores nothing');
  perform t.eq(t.value('LC-B'), 2000.00, 'preview changes no cost');

  lc := inv.create_landed_cost(jsonb_build_object('amount', 300, 'description', 'Frakt DSV', 'invoice_ref', 'F-1',
          'receipts', jsonb_build_array(gr->>'number'), 'by', 'test'));
  v_lc := (lc->>'id')::uuid;
  perform t.ok((lc->>'number') like 'LC-%', 'number');
  perform t.eq(lc->>'method', 'value', 'default method');
  perform t.eq(lc->>'currency', 'NOK', 'base currency');
  perform t.eq((lc->>'amount_base')::numeric, 300.00, 'amount base');
  perform t.eq((lc->>'applied_base')::numeric, 300.00, 'applied');
  perform t.eq((lc->>'rounding_diff')::numeric, 0.00, 'no rounding diff');
  perform t.eq((lc->>'to_stock')::numeric, 250.00, 'to stock 5*10 + 5*40');
  perform t.eq((lc->>'to_cogs')::numeric, 40.00, 'to cogs 4*10');
  perform t.eq((lc->>'to_other')::numeric, 10.00, 'to write-off 1*10');
  perform t.eq(jsonb_array_length(lc->'lines'), 2, 'two lines');
  perform t.eq((select (l->>'unit_delta')::numeric from jsonb_array_elements(lc->'lines') l where l->>'sku' = 'LC-A'), 10.0000, 'A delta');
  perform t.eq((select (l->>'unit_delta')::numeric from jsonb_array_elements(lc->'lines') l where l->>'sku' = 'LC-B'), 40.0000, 'B delta');
  perform t.eq((select (l->>'qty_sold')::numeric from jsonb_array_elements(lc->'lines') l where l->>'sku' = 'LC-A'), 4.000, 'A sold 4');
  perform t.eq((select (l->>'qty_in_stock')::numeric from jsonb_array_elements(lc->'lines') l where l->>'sku' = 'LC-A'), 5.000, 'A in stock 5');
  perform t.eq((select (l->>'unit_cost_after')::numeric from jsonb_array_elements(lc->'lines') l where l->>'sku' = 'LC-B'), 440.0000, 'B cost after');

  -- Stock is revalued, also what was moved to another location
  perform t.eq(t.value('LC-A', 'MAIN'), 220.00, 'A main 2*110');
  perform t.eq(t.value('LC-A', 'BUTIKK'), 330.00, 'A butikk 3*110');
  perform t.eq(t.value('LC-B'), 2200.00, 'B 5*440');
  -- Sales are re-costed and the change is logged
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = '50'), 330.00, 'woo sale 3*110');
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = 'POS-1'), 110.00, 'butikk sale 1*110');
  perform t.eq((select sum(delta_cost) from inv.cogs_correction where landed_cost_id = v_lc and reason = 'landed_cost'), 40.00, 'cogs corrections');
  perform t.ok((select last_cost_change_at from inv.v_sale_line_cost where order_id = '50') is not null, 'cost change visible on the order line');
  perform t.eq((select landed_cost_per_unit from inv.v_sale_cost_source where order_id = '50'), 10.0000, 'landed cost on the source row');
  -- Other movements follow
  perform t.eq((select total_cost from inv.movement where id = v_woff), 110.00, 'write-off re-costed');
  perform t.eq((select total_cost from inv.movement where id = v_tout), 440.00, 'transfer out re-costed');
  perform t.eq((select total_cost from inv.movement where id = v_tin), 440.00, 'transfer in re-costed');
  perform t.eq((select unit_cost from inv.movement where id = v_tin), 110.0000, 'transfer in unit cost');
  -- The receipt itself
  perform t.eq((select landed_cost_per_unit from inv.goods_receipt_line grl join inv.item i on i.id = grl.item_id where grl.receipt_id = v_gr and i.sku = 'LC-A'), 10.0000, 'receipt line landed');
  perform t.eq((select unit_cost_base from inv.goods_receipt_line grl join inv.item i on i.id = grl.item_id where grl.receipt_id = v_gr and i.sku = 'LC-A'), 110.0000, 'receipt line base cost');
  perform t.eq((select m.total_cost from inv.goods_receipt_line grl join inv.movement m on m.id = grl.movement_id join inv.item i on i.id = grl.item_id where grl.receipt_id = v_gr and i.sku = 'LC-A'), 1100.00, 'receipt movement total');
  perform t.eq((select last_purchase_cost from inv.v_item_status where sku = 'LC-A'), 110.0000, 'last purchase cost includes freight');
  -- Stock as of now still equals the balances (month close reads the same layers)
  perform t.eq((select sum(value) from inv._stock_as_of(now() + interval '1 minute')), (select sum(value) from inv.stock_balance), 'stock as of = balances');
  perform t.integrity();

  -- A receipt with a posted landed cost cannot be reversed
  perform t.expect_error(format('select inv.reverse_goods_receipt(%L)', v_gr), 'LANDED_COST_POSTED');

  -- Reversal takes the same amounts out again
  lc := inv.reverse_landed_cost(v_lc, 'test', 'feil faktura');
  perform t.eq(lc->>'status', 'reversed', 'reversed');
  perform t.eq(lc->>'reversed_by', 'test', 'reversed by');
  perform t.eq(t.value('LC-A', 'MAIN'), 200.00, 'A main back');
  perform t.eq(t.value('LC-A', 'BUTIKK'), 300.00, 'A butikk back');
  perform t.eq(t.value('LC-B'), 2000.00, 'B back');
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = '50'), 300.00, 'woo sale back');
  perform t.eq((select total_cost from inv.movement where id = v_woff), 100.00, 'write-off back');
  perform t.eq((select total_cost from inv.movement where id = v_tin), 400.00, 'transfer in back');
  perform t.eq((select sum(delta_cost) from inv.cogs_correction where landed_cost_id = v_lc), 0.00, 'corrections net to 0');
  perform t.eq((select count(*) from inv.cogs_correction where landed_cost_id = v_lc and reason = 'landed_cost_reversal')::int, 2, 'reversal rows logged');
  perform t.eq((select unit_cost_base from inv.goods_receipt_line grl join inv.item i on i.id = grl.item_id where grl.receipt_id = v_gr and i.sku = 'LC-B'), 400.0000, 'receipt line back');
  perform t.expect_error(format('select inv.reverse_landed_cost(%L)', v_lc), 'ALREADY_REVERSED');
  perform t.integrity();
end $$;

-- B) By qty over every receipt of a PO (two partial receipts)
select t.item('LC-E');
do $$
declare po jsonb; v_po uuid; lc jsonb;
begin
  po := inv.create_purchase_order('{"supplier_name":"Tojiro","lines":[{"sku":"LC-E","qty":10,"unit_cost":10}]}');
  v_po := (po->>'id')::uuid;
  perform inv.set_purchase_order_status(v_po, 'sent', 'test');
  perform inv.receive_purchase_order(v_po, '{"lines":[{"sku":"LC-E","qty":6}]}');
  perform inv.receive_purchase_order(v_po, '{"lines":[{"sku":"LC-E","qty":4}]}');
  lc := inv.create_landed_cost(jsonb_build_object('amount', 50, 'method', 'qty', 'po', po->>'number'));
  perform t.eq(jsonb_array_length(lc->'lines'), 2, 'both receipts');
  perform t.eq(jsonb_array_length(lc->'receipts'), 2, 'receipts listed');
  perform t.eq((select count(*) from jsonb_array_elements(lc->'lines') l where (l->>'unit_delta')::numeric = 5)::int, 2, '5 per unit on both');
  perform t.eq(t.value('LC-E'), 150.00, '10 * 15');
end $$;

-- C) Manual amounts in foreign currency
select t.item('LC-D');
do $$
declare gr jsonb; lc jsonb;
begin
  gr := t.receive('LC-D', 4, 100);
  perform t.expect_error(format('select inv.create_landed_cost(%L)',
    jsonb_build_object('currency', 'EUR', 'lines', jsonb_build_array(jsonb_build_object('receipt', gr->>'number', 'sku', 'LC-D', 'amount', 10)))::text), 'VALIDATION');
  lc := inv.create_landed_cost(jsonb_build_object('currency', 'eur', 'fx_rate', 11.5,
          'lines', jsonb_build_array(jsonb_build_object('receipt', gr->>'number', 'sku', 'LC-D', 'amount', 10))));
  perform t.eq(lc->>'method', 'manual', 'manual implied by lines');
  perform t.eq(lc->>'currency', 'EUR', 'currency upper');
  perform t.eq((lc->>'amount')::numeric, 10.00, 'amount from lines');
  perform t.eq((lc->>'amount_base')::numeric, 115.00, 'base amount');
  perform t.eq((lc->'lines'->0->>'unit_delta')::numeric, 28.7500, 'delta');
  perform t.eq(t.value('LC-D'), 515.00, '4 * 128.75');
  perform t.expect_error(format('select inv.create_landed_cost(%L)',
    jsonb_build_object('amount', 99, 'lines', jsonb_build_array(jsonb_build_object('receipt', gr->>'number', 'sku', 'LC-D', 'amount', 10)))::text), 'VALIDATION');
end $$;

-- D) Rounding: 100 over 3 units → 33.3333 per unit, applied 100.00
select t.item('LC-F');
do $$
declare gr jsonb; lc jsonb;
begin
  gr := t.receive('LC-F', 3, 10);
  lc := inv.create_landed_cost(jsonb_build_object('amount', 100, 'receipts', jsonb_build_array(gr->>'id')));
  perform t.eq((lc->'lines'->0->>'unit_delta')::numeric, 33.3333, 'delta 4 decimals');
  perform t.eq((lc->>'applied_base')::numeric, 100.00, 'applied');
  perform t.eq(t.value('LC-F'), 130.00, 'value');
end $$;

-- E) A reversed sale is not COGS: its units are back in stock
select t.item('LC-G');
do $$
declare gr jsonb; lc jsonb; v_sale bigint;
begin
  gr := t.receive('LC-G', 2, 10);
  v_sale := (inv.record_sale('{"ref_id":"G1","lines":[{"sku":"LC-G","qty":1}]}')->'movements'->0->>'id')::bigint;
  perform inv.reverse_movement(v_sale, 'test', 'feil');
  lc := inv.create_landed_cost(jsonb_build_object('amount', 20, 'receipts', jsonb_build_array(gr->>'number')));
  perform t.eq((lc->>'to_cogs')::numeric, 0.00, 'no cogs');
  perform t.eq((lc->>'to_stock')::numeric, 20.00, 'all to stock');
  perform t.eq((lc->'lines'->0->>'qty_in_stock')::numeric, 2.000, '2 in stock');
  perform t.eq(t.value('LC-G'), 40.00, 'value 2 * 20');
  perform t.eq((select count(*) from inv.cogs_correction where landed_cost_id = (lc->>'id')::uuid)::int, 0, 'no correction for a reversed sale');
  perform t.integrity();
end $$;

-- F) Sale on negative stock covered by the receipt, then freight on that receipt
select t.item('LC-H');
do $$
declare gr jsonb; lc jsonb;
begin
  perform t.receive('LC-H', 1, 100, '2026-09-01');
  perform inv.record_sale('{"ref_id":"H0","lines":[{"sku":"LC-H","qty":1}]}');
  perform inv.record_sale('{"ref_id":"H1","lines":[{"sku":"LC-H","qty":2}]}');
  gr := t.receive('LC-H', 5, 100, '2026-09-10');
  lc := inv.create_landed_cost(jsonb_build_object('amount', 50, 'receipts', jsonb_build_array(gr->>'number')));
  perform t.eq((lc->>'to_cogs')::numeric, 20.00, 'covered sale gets the freight');
  perform t.eq((lc->>'to_stock')::numeric, 30.00, 'rest to stock');
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = 'H1'), 220.00, 'sale 2 * 110');
  perform t.eq((select cogs from inv.v_sale_line_cost where order_id = 'H0'), 100.00, 'earlier sale untouched');
  perform t.integrity();
end $$;

-- G) Receipt reversal: blocked while posted, allowed after the landed cost is reversed
select t.item('LC-C');
do $$
declare gr jsonb; lc jsonb;
begin
  gr := t.receive('LC-C', 2, 50);
  lc := inv.create_landed_cost(jsonb_build_object('amount', 20, 'method', 'qty', 'receipts', jsonb_build_array(gr->>'number')));
  perform t.expect_error(format('select inv.reverse_goods_receipt(%L)', gr->>'id'), 'LANDED_COST_POSTED');
  perform inv.reverse_landed_cost((lc->>'id')::uuid);
  perform inv.reverse_goods_receipt((gr->>'id')::uuid);
  perform t.eq(t.on_hand('LC-C'), 0::numeric, 'receipt reversed');
  perform t.expect_error(format('select inv.create_landed_cost(%L)',
    jsonb_build_object('amount', 20, 'receipts', jsonb_build_array(gr->>'number'))::text), 'VALIDATION');
  -- Validation
  perform t.expect_error($q$select inv.create_landed_cost('{"amount":10}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_landed_cost('{"amount":0,"receipts":["GR-000001"]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.create_landed_cost('{"amount":10,"receipts":["GR-999999"]}')$q$, 'NOT_FOUND');
  perform t.expect_error($q$select inv.create_landed_cost('{"amount":10,"po":"PO-99999"}')$q$, 'PO_NOT_FOUND');
  perform t.expect_error($q$select inv.create_landed_cost('{"amount":10,"method":"weight","receipts":["GR-000001"]}')$q$, 'VALIDATION');
  perform t.expect_error($q$select inv.reverse_landed_cost('00000000-0000-0000-0000-000000000000')$q$, 'NOT_FOUND');
  perform t.integrity();
end $$;

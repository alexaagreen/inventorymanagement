-- v0.10.0: supplier rules (checklist), order_unit, buying in packs, invoice line matching
select t.item('LK-DRY-DSV');      -- one 2.5 kg bag (what we stock and sell)
select t.item('LK-WET-LAMB');     -- one 400 g can
select t.item('LK-DRY-LAMB-7');   -- one 7 kg bag
do $$
declare s jsonb; v_sup uuid; m jsonb; po jsonb; po2 jsonb; l jsonb;
begin
  -- rules: one per line (string) or an array; order_unit validated
  s := inv.upsert_supplier(jsonb_build_object('name', 'A/S Nestlé Norge', 'order_unit', 'pack',
         'rules', E'Invoice quantities are cases, not units\n\n  Use the EHF net price  '));
  v_sup := (s->>'id')::uuid;
  perform t.eq(s->'rules', '["Invoice quantities are cases, not units", "Use the EHF net price"]'::jsonb, 'rules from text, trimmed, blanks dropped');
  perform t.eq(s->>'order_unit', 'pack', 'order_unit stored');
  s := inv.upsert_supplier(jsonb_build_object('id', v_sup, 'rules', '["One", "Two", ""]'::jsonb));
  perform t.eq(jsonb_array_length(s->'rules'), 2, 'rules from array');
  perform t.eq(s->>'order_unit', 'pack', 'order_unit kept when not sent');
  perform t.expect_error(format($q$select inv.upsert_supplier('{"id":"%s","order_unit":"box"}')$q$, v_sup), 'VALIDATION');
  perform t.expect_error($q$select inv.upsert_supplier('{"name":"X","rules":{"a":1}}')$q$, 'VALIDATION');

  -- links: article number stored without zero padding, GTIN of the case, pack_qty known for one item
  perform inv.set_item_supplier(jsonb_build_object('sku', 'LK-DRY-DSV', 'supplier', v_sup, 'supplier_sku', '12583641',
            'pack_gtin', '5060184241403', 'pack_name', 'case 4 × 2.5 kg'));
  perform inv.set_item_supplier(jsonb_build_object('sku', 'LK-WET-LAMB', 'supplier', v_sup, 'pack_gtin', '05056273610571', 'pack_qty', 6));
  perform t.expect_error(format($q$select inv.set_item_supplier('{"sku":"LK-WET-LAMB","supplier":"%s","pack_qty":0}')$q$, v_sup), 'VALIDATION');
  l := (select x from jsonb_array_elements(inv.list_item_suppliers('LK-WET-LAMB')) x limit 1);
  perform t.eq((l->>'pack_qty')::numeric, 6.000, 'pack_qty on link');
  perform t.eq(l->>'supplier_order_unit', 'pack', 'supplier order unit on link');

  -- invoice preview (no writes)
  m := inv.match_supplier_lines(jsonb_build_object('supplier', 'a/s nestlé norge', 'lines', jsonb_build_array(
         jsonb_build_object('supplier_sku', '000000000012583641', 'description', 'LK DogDry Du/Sal&Ven (4x2,5kg)', 'qty', 1, 'net_amount', 620.82),
         jsonb_build_object('gtin', '5056273610571', 'description', 'LK DogWet Lamb Hotpot (6x400g)', 'qty', 4, 'net_amount', 545.33),
         jsonb_build_object('supplier_sku', '000000000012583476', 'description', 'LK DogDry Lamb (1x7kg)', 'qty', 1, 'net_amount', 363.43))));
  perform t.eq((m->>'matched')::int, 2, 'two lines matched');
  perform t.eq((m->>'unmatched')::int, 1, 'one line not linked yet');
  perform t.eq((m->>'total_net')::numeric, 1529.58, 'total net');
  perform t.eq(m->'lines'->0->>'sku', 'LK-DRY-DSV', 'matched by zero-padded article number');
  perform t.eq((m->'lines'->0->>'units')::numeric, 4::numeric, '1 case = 4 bags (from the description)');
  perform t.eq(m->'lines'->0->>'pack_qty_source', 'description', 'pack_qty source');
  perform t.eq((m->'lines'->0->>'unit_cost')::numeric, 155.2050, 'unit cost per bag');
  perform t.eq(m->'lines'->1->>'sku', 'LK-WET-LAMB', 'matched by GTIN');
  perform t.eq((m->'lines'->1->>'units')::numeric, 24::numeric, '4 cases × 6 cans');
  perform t.eq(m->'lines'->1->>'pack_qty_source', 'link', 'pack_qty from link');
  perform t.ok(m->'lines'->2->'po_line' = 'null'::jsonb, 'unmatched line has no po_line');
  perform t.eq((m->'lines'->2->>'pack_qty')::numeric, 1::numeric, '(1x7kg) → 1');
  perform t.eq((inv.match_supplier_lines(jsonb_build_object('supplier', v_sup, 'qty_in', 'unit',
            'lines', jsonb_build_array(jsonb_build_object('supplier_sku', '12583641', 'qty', 4, 'unit_price', 10))))->'lines'->0->>'units')::numeric,
          4::numeric, 'qty_in=unit: no conversion');

  -- PO straight from the preview: packs, pack_price, supplier refs
  po := inv.create_purchase_order(jsonb_build_object('supplier_id', v_sup, 'supplier_name', 'A/S Nestlé Norge', 'supplier_ref', '1368748532',
          'lines', jsonb_build_array(m->'lines'->0->'po_line', m->'lines'->1->'po_line',
                     jsonb_build_object('sku', 'LK-DRY-LAMB-7', 'supplier_sku', '000000000012583476', 'packs', 1,
                                        'pack_price', 363.43, 'description', 'LK DogDry Lamb (1x7kg)'))));
  perform t.eq((po->'lines'->0->>'qty_ordered')::numeric, 4.000, 'qty in units');
  perform t.eq((po->'lines'->0->>'packs')::numeric, 1.000, 'packs kept on the line');
  perform t.eq((po->'lines'->0->>'pack_qty')::numeric, 4.000, 'pack_qty kept on the line');
  perform t.eq((po->'lines'->0->>'unit_cost')::numeric, 155.2050, 'unit cost per bag');
  perform t.eq((po->'lines'->1->>'qty_ordered')::numeric, 24.000, '24 cans');
  perform t.eq((po->'totals'->>'amount')::numeric, 1529.58, 'PO total = invoice net');
  -- the PO taught the links: pack_qty from the description, article number for the new item
  perform t.eq((select pack_qty from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'LK-DRY-DSV'), 4.000, 'link learned pack_qty 4');
  perform t.eq((select supplier_sku from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'LK-DRY-LAMB-7'), '000000000012583476', 'link learned article no');
  perform t.eq((select pack_qty from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'LK-DRY-LAMB-7'), 1.000, 'link learned pack_qty 1');

  -- next invoice: everything matches by article number alone, packs converted from the link
  po2 := inv.create_purchase_order(jsonb_build_object('supplier_id', v_sup, 'supplier_name', 'x',
          'lines', jsonb_build_array(jsonb_build_object('supplier_sku', '12583641', 'packs', 2, 'pack_price', 620.82),
                                     jsonb_build_object('supplier_sku', '12583476', 'packs', 3, 'unit_cost', 363.43))));
  perform t.eq(po2->'lines'->0->>'sku', 'LK-DRY-DSV', 'resolved by article number');
  perform t.eq((po2->'lines'->0->>'qty_ordered')::numeric, 8.000, '2 cases → 8 bags');
  perform t.eq((po2->'lines'->1->>'qty_ordered')::numeric, 3.000, '3 × 1');
  perform t.eq((po2->'lines'->1->>'unit_cost')::numeric, 363.4300, 'unit_cost passes through');

  -- errors
  perform t.expect_error(format($q$select inv.create_purchase_order('{"supplier_id":"%s","supplier_name":"x","lines":[{"supplier_sku":"999","packs":1,"pack_price":1}]}')$q$, v_sup), 'ITEM_NOT_FOUND');
  perform t.expect_error(format($q$select inv.create_purchase_order('{"supplier_id":"%s","supplier_name":"x","lines":[{"sku":"LK-DRY-DSV","packs":1,"qty":5,"unit_cost":1}]}')$q$, v_sup), 'VALIDATION');
  perform t.expect_error(format($q$select inv.create_purchase_order('{"supplier_id":"%s","supplier_name":"x","lines":[{"sku":"LK-DRY-DSV","packs":1,"pack_price":8,"unit_cost":5}]}')$q$, v_sup), 'VALIDATION');
  perform t.expect_error(format($q$select inv.create_purchase_order('{"supplier_id":"%s","supplier_name":"x","lines":[{"sku":"LK-DRY-DSV","packs":0,"unit_cost":5}]}')$q$, v_sup), 'VALIDATION');
  perform t.expect_error($q$select inv.create_purchase_order('{"supplier_name":"x","lines":[{"qty":1,"unit_cost":1}]}')$q$, 'VALIDATION');
  -- plain unit lines still work exactly as before
  perform t.eq((inv.create_purchase_order('{"supplier_name":"Other AS","lines":[{"sku":"LK-WET-LAMB","qty":3,"unit_cost":20}]}')->'lines'->0->>'packs'), null, 'unit line has no packs');

  -- receiving the pack PO puts units on stock
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'sent', 'test');
  perform inv.receive_purchase_order((po->>'id')::uuid, '{"by":"test","lines":[{"sku":"LK-DRY-DSV","qty":4},{"sku":"LK-WET-LAMB","qty":24},{"sku":"LK-DRY-LAMB-7","qty":1}]}');
  perform t.eq(t.on_hand('LK-DRY-DSV'), 4.000, '4 bags on stock');
  perform t.eq(t.on_hand('LK-WET-LAMB'), 24.000, '24 cans on stock');
  perform t.eq(t.value('LK-DRY-DSV'), 620.82, 'stock value = case price');
  perform t.integrity();
end $$;

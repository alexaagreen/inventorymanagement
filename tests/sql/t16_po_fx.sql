-- T16: PO i JPY 10 @ 1500, fx 0.071, landed 5 → 111.5; delmottak 6 → partially_received, on_order 4
select t.item('KNIV-1');
do $$
declare po jsonb; gr jsonb; v_po uuid;
begin
  po := inv.create_purchase_order('{"supplier_name":"Tojiro","currency":"jpy","fx_rate":0.071,"expected_at":"2026-11-01",
          "lines":[{"sku":"KNIV-1","qty":10,"unit_cost":1500,"landed_cost_per_unit":5}]}');
  v_po := (po->>'id')::uuid;
  perform t.eq(po->>'currency', 'JPY', 'currency upper');
  perform t.eq(po->>'status', 'draft', 'draft');
  perform t.ok((po->>'number') like 'PO-%', 'number');
  -- draft teller ikke som on_order
  perform t.eq((select on_order from inv.v_item_status where sku='KNIV-1'), 0::numeric, 'draft not on order');
  perform t.expect_error(format('select inv.receive_purchase_order(%L, %L)', v_po, '{"lines":[{"sku":"KNIV-1","qty":1}]}'), 'PO_STATUS_INVALID');
  perform inv.set_purchase_order_status(v_po, 'sent', 'test');
  perform t.eq((select on_order from inv.v_item_status where sku='KNIV-1'), 10.000, 'on order 10');
  perform t.eq((select next_delivery from inv.v_item_status where sku='KNIV-1'), '2026-11-01'::date, 'next delivery');

  gr := inv.receive_purchase_order(v_po, '{"by":"test","lines":[{"sku":"KNIV-1","qty":6}]}');
  perform t.eq((gr->'lines'->0->>'unit_cost_base')::numeric, 111.5000, 'base cost');
  perform t.eq((gr->'movements'->0->>'unit_cost')::numeric, 111.5000, 'movement cost');
  perform t.eq(gr->'purchase_order'->>'status', 'partially_received', 'partial');
  perform t.eq((select on_order from inv.v_item_status where sku='KNIV-1'), 4.000, 'on order 4');

  -- Mottakslinje med avvikende pris (pris logges på linjen)
  gr := inv.receive_purchase_order(v_po, '{"by":"test","fx_rate":0.07,"lines":[{"sku":"KNIV-1","qty":4,"unit_cost":1400}]}');
  perform t.eq((gr->'lines'->0->>'unit_cost_base')::numeric, 103.0000, '1400*0.07+5');
  perform t.eq(gr->'purchase_order'->>'status', 'received', 'received');
  perform t.eq((select last_purchase_cost from inv.v_item_status where sku='KNIV-1'), 103.0000, 'last purchase cost');
  perform t.expect_error(format('select inv.update_purchase_order(%L, %L)', v_po, '{"note":"x"}'), 'PO_LOCKED');
  perform inv.set_purchase_order_status(v_po, 'closed', 'test');
  perform t.integrity();
end $$;

-- Fremmed valuta uten kurs → VALIDATION ved mottak
do $$
declare po jsonb;
begin
  po := inv.create_purchase_order('{"supplier_name":"X","currency":"EUR","lines":[{"sku":"KNIV-1","qty":1,"unit_cost":10}]}');
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'sent', null);
  perform t.expect_error(format('select inv.receive_purchase_order(%L, %L)', po->>'id', '{"lines":[{"sku":"KNIV-1","qty":1}]}'), 'VALIDATION');
  perform t.expect_error($q$select inv.create_purchase_order('{"supplier_name":"X","lines":[{"sku":"KNIV-1","qty":1,"unit_cost":1},{"sku":"knív-1","qty":1,"unit_cost":1}]}')$q$, 'ITEM_NOT_FOUND');
  perform t.expect_error($q$select inv.create_purchase_order('{"supplier_name":"X","lines":[{"sku":"KNIV-1","qty":1,"unit_cost":1},{"sku":"kniv-1","qty":2,"unit_cost":1}]}')$q$, 'VALIDATION');
  -- linjer kan endres i sent uten mottak, historikk logges
  po := inv.update_purchase_order((po->>'id')::uuid, '{"by":"test","lines":[{"sku":"KNIV-1","qty":3,"unit_cost":11}]}');
  perform t.eq((po->'lines'->0->>'qty_ordered')::numeric, 3.000, 'lines replaced');
  perform t.eq(jsonb_array_length(po->'metadata'->'history'), 1, 'history logged');
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'cancelled', null);
  perform t.expect_error(format('select inv.set_purchase_order_status(%L, %L)', po->>'id', 'sent'), 'PO_STATUS_INVALID');
end $$;

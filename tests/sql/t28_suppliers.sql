-- v0.7.0: supplier register, item ↔ supplier (many-to-many), last purchase per supplier
select t.item('SKI-A'); select t.item('SKI-B');
do $$
declare po jsonb; po2 jsonb; gr jsonb; gr2 jsonb; r jsonb; v_s1 uuid; v_s2 uuid; s jsonb;
begin
  -- PO with only a supplier name registers the supplier and links the item as preferred
  po := inv.create_purchase_order('{"supplier_name":"Alpine Works","currency":"EUR","fx_rate":11.5,
          "lines":[{"sku":"SKI-A","qty":10,"unit_cost":200}]}');
  v_s1 := (select supplier_uuid from inv.purchase_order where id = (po->>'id')::uuid);
  perform t.ok(v_s1 is not null, 'supplier registered from PO');
  perform t.eq((select currency from inv.supplier where id = v_s1), 'EUR', 'supplier currency from PO');
  perform t.eq((select preferred from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'SKI-A' and x.supplier_id = v_s1), true, 'first link preferred');

  -- same name, other casing → same supplier
  po2 := inv.create_purchase_order('{"supplier_name":"  alpine works ","lines":[{"sku":"SKI-B","qty":1,"unit_cost":1}]}');
  perform t.eq((select supplier_uuid from inv.purchase_order where id = (po2->>'id')::uuid), v_s1, 'name match is case-insensitive');
  perform t.eq((select supplier_name from inv.purchase_order where id = (po2->>'id')::uuid), 'Alpine Works', 'PO shows register name');

  -- second supplier via register uuid
  s := inv.upsert_supplier('{"name":"Nordic Edge","currency":"NOK","code":"NE","default_lead_time_days":14}');
  v_s2 := (s->>'id')::uuid;
  perform t.expect_error($q$select inv.upsert_supplier('{"name":"NORDIC EDGE"}')$q$, 'DUPLICATE_REF');
  po2 := inv.create_purchase_order(jsonb_build_object('supplier_name', 'ignored', 'supplier_id', v_s2,
           'lines', jsonb_build_array(jsonb_build_object('sku', 'SKI-A', 'qty', 5, 'unit_cost', 2400))));
  perform t.eq((select supplier_uuid from inv.purchase_order where id = (po2->>'id')::uuid), v_s2, 'supplier_id uuid wins');
  perform t.eq((select supplier_name from inv.purchase_order where id = (po2->>'id')::uuid), 'Nordic Edge', 'name from register');
  perform t.eq((select count(*)::int from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'SKI-A'), 2, 'SKI-A has two suppliers');
  perform t.eq((select preferred_supplier from inv.v_item_purchase_info where sku = 'SKI-A'), 'Alpine Works', 'preferred unchanged');

  -- receipts: last purchase per supplier and overall
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'sent', 'test');
  perform inv.set_purchase_order_status((po2->>'id')::uuid, 'sent', 'test');
  gr := inv.receive_purchase_order((po->>'id')::uuid, '{"by":"test","received_at":"2026-09-01T10:00:00Z","lines":[{"sku":"SKI-A","qty":10,"unit_cost":210}]}');
  gr2 := inv.receive_purchase_order((po2->>'id')::uuid, '{"by":"test","received_at":"2026-10-01T10:00:00Z","lines":[{"sku":"SKI-A","qty":5}]}');
  r := (select to_jsonb(pi) from inv.v_item_purchase_info pi where sku = 'SKI-A');
  perform t.eq(r->>'last_supplier', 'Nordic Edge', 'last bought from');
  perform t.eq((r->>'last_unit_cost')::numeric, 2400.0000, 'last price in PO currency');
  perform t.eq(r->>'last_currency', 'NOK', 'last currency');
  perform t.eq((select last_unit_cost from inv.v_item_supplier where sku = 'SKI-A' and supplier_id = v_s1), 210.0000, 'last price from Alpine (receipt line price)');
  perform t.eq((select last_unit_cost_nok from inv.v_item_supplier where sku = 'SKI-A' and supplier_id = v_s1), 2415.0000, '210 × 11.5');
  perform t.eq((select qty_purchased from inv.v_item_supplier where sku = 'SKI-A' and supplier_id = v_s1), 10.000, 'qty purchased');

  -- reversing the newest receipt: last purchase falls back to Alpine
  perform inv.reverse_goods_receipt((gr2->>'id')::uuid, 'test', 'wrong');
  perform t.eq((select last_supplier from inv.v_item_purchase_info where sku = 'SKI-A'), 'Alpine Works', 'reversal corrects last supplier');

  -- move preference, then remove the preferred link
  r := inv.set_item_supplier(jsonb_build_object('sku', 'ski-a', 'supplier', 'NE', 'preferred', true, 'supplier_sku', 'NE-778', 'list_price', 2350));
  perform t.eq(r->0->>'supplier_name', 'Nordic Edge', 'preferred listed first');
  perform t.eq((r->0->>'preferred')::boolean, true, 'preferred moved');
  perform t.eq((select count(*)::int from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'SKI-A' and x.preferred), 1, 'exactly one preferred');
  perform t.eq(r->0->>'supplier_sku', 'NE-778', 'supplier sku');
  perform t.eq(r->0->>'list_currency', 'NOK', 'list currency defaults to supplier currency');
  perform t.eq((r->0->>'lead_time_days')::int, 14, 'lead time from supplier default');
  r := inv.remove_item_supplier(jsonb_build_object('sku', 'SKI-A', 'supplier', v_s2));
  perform t.eq(jsonb_array_length(r), 1, 'one link left');
  perform t.eq((r->0->>'preferred')::boolean, true, 'remaining supplier promoted to preferred');
  perform t.expect_error(format('select inv.remove_item_supplier(%L)', jsonb_build_object('sku', 'SKI-A', 'supplier', v_s2)), 'NOT_FOUND');
  perform t.expect_error($q$select inv.set_item_supplier('{"sku":"SKI-A","supplier":"Nobody AS"}')$q$, 'SUPPLIER_NOT_FOUND');

  -- rename follows open POs; get_item_status carries suppliers + purchase
  perform inv.upsert_supplier(jsonb_build_object('id', v_s1, 'name', 'Alpine Works GmbH'));
  perform t.eq((select supplier_name from inv.purchase_order where id = (po->>'id')::uuid), 'Alpine Works GmbH', 'rename on POs');
  r := inv.get_item_status('SKI-A');
  perform t.eq(jsonb_array_length(r->'suppliers'), 1, 'status has suppliers');
  perform t.eq(r->'purchase'->>'preferred_supplier', 'Alpine Works GmbH', 'status has purchase info');
  perform t.integrity();
end $$;

-- bulk import: validation, dry run, create_suppliers, all-or-nothing
select t.item('SKI-C');
do $$
declare r jsonb;
begin
  r := inv.import_item_suppliers('{"rows":[{"sku":"SKI-C","supplier":"Nordic Edge","preferred":true},{"sku":"NOPE","supplier":"Nordic Edge"},{"sku":"SKI-C","supplier":"New Co"}]}');
  perform t.eq((r->>'ok')::boolean, false, 'errors → not ok');
  perform t.eq(jsonb_array_length(r->'errors'), 2, 'unknown sku + unknown supplier');
  perform t.eq((select count(*)::int from inv.item_supplier x join inv.item i on i.id = x.item_id where i.sku = 'SKI-C'), 0, 'nothing written');
  r := inv.import_item_suppliers('{"dry_run":true,"create_suppliers":true,"rows":[{"sku":"SKI-C","supplier":"Nordic Edge","preferred":true},{"sku":"SKI-C","supplier":"New Co","supplier_sku":"NC-1"}]}');
  perform t.eq((r->>'new_suppliers')::int, 1, 'dry run counts new suppliers');
  perform t.eq((select count(*)::int from inv.supplier where name = 'New Co'), 0, 'dry run writes nothing');
  r := inv.import_item_suppliers('{"create_suppliers":true,"rows":[{"sku":"SKI-C","supplier":"Nordic Edge","preferred":true},{"sku":"SKI-C","supplier":"New Co","supplier_sku":"NC-1"}]}');
  perform t.eq((r->>'linked')::int, 2, 'linked');
  perform t.eq((select preferred_supplier from inv.v_item_purchase_info where sku = 'SKI-C'), 'Nordic Edge', 'preferred from import');
  perform t.eq((select supplier_sku from inv.v_item_supplier where sku = 'SKI-C' and supplier_name = 'New Co'), 'NC-1', 'supplier sku from import');
  perform t.eq((select item_count from inv.v_supplier where name = 'Nordic Edge'), 1, 'supplier item count');
end $$;

-- Regression (majestyweb db push, 0093 backfill): names that are not uuids must never be
-- cast. Supabase runs random_page_cost = 1.1, which makes the planner use a BitmapOr on
-- supplier_pkey / code / name; force that plan here and look up by name, code and uuid.
set enable_seqscan = off;
do $$
declare v uuid; po jsonb;
begin
  v := (inv.upsert_supplier('{"name":"MJST SPÓŁKA Z O.O.","currency":"PLN","code":"MJST"}')->>'id')::uuid;
  perform t.eq(inv._find_supplier('MJST SPÓŁKA Z O.O.'), v, 'find by non-uuid name (index plan)');
  perform t.eq(inv._find_supplier('  mjst spółka z o.o. '), v, 'find by name, any case/spacing');
  perform t.eq(inv._find_supplier('MJST'), v, 'find by code');
  perform t.eq(inv._find_supplier(upper(v::text)), v, 'find by uuid text');
  perform t.ok(inv._find_supplier('not-a-uuid-0000') is null, 'unknown ref → null, no error');
  perform t.ok(inv._to_uuid('MJST SPÓŁKA Z O.O.') is null, '_to_uuid never raises');
  perform t.eq(inv._ensure_supplier('MJST SPÓŁKA Z O.O.', 'PLN'), v, 'ensure finds existing');
  -- PO whose supplier_id holds a name (not a register uuid) resolves by supplier_name
  po := inv.create_purchase_order('{"supplier_id":"MJST SPÓŁKA Z O.O.","supplier_name":"MJST SPÓŁKA Z O.O.","currency":"PLN","fx_rate":2.7,
          "lines":[{"sku":"SKI-C","qty":1,"unit_cost":10}]}');
  perform t.eq((select supplier_uuid from inv.purchase_order where id = (po->>'id')::uuid), v, 'PO with name in supplier_id');
  -- the backfill statement itself, re-run over every PO
  update inv.purchase_order set supplier_uuid = null;
  update inv.purchase_order set supplier_uuid = inv._ensure_supplier(supplier_name, currency) where supplier_uuid is null;
  perform t.eq((select count(*)::int from inv.purchase_order where supplier_uuid is null), 0, 'backfill resolves every PO');
end $$;
reset enable_seqscan;

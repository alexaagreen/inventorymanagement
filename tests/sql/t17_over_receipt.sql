-- T17: Mottak 12 på linje med 10 bestilt uten allow_over_receipt → OVER_RECEIPT; med flagg ok
select t.item('KNIV-1');
do $$
declare po jsonb; gr jsonb;
begin
  po := inv.create_purchase_order('{"supplier_name":"X","lines":[{"sku":"KNIV-1","qty":10,"unit_cost":100}]}');
  perform inv.set_purchase_order_status((po->>'id')::uuid, 'sent', null);
  perform t.expect_error(format('select inv.receive_purchase_order(%L, %L)', po->>'id', '{"lines":[{"sku":"KNIV-1","qty":12}]}'), 'OVER_RECEIPT');
  perform t.eq(t.on_hand('KNIV-1'), 0::numeric, 'nothing received');
  gr := inv.receive_purchase_order((po->>'id')::uuid, ('{"allow_over_receipt":true,"lines":[{"po_line_id":"' || (po->'lines'->0->>'id') || '","qty":12}]}')::jsonb);
  perform t.eq((gr->'purchase_order'->'lines'->0->>'qty_received')::numeric, 12.000, 'qty_received 12');
  perform t.eq(gr->'purchase_order'->>'status', 'received', 'received');
  perform t.eq((select on_order from inv.v_item_status where sku='KNIV-1'), 0::numeric, 'no negative on_order');
  perform t.integrity();
end $$;

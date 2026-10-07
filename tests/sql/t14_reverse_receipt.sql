-- T14: Mottak 10@100, salg 3, reverser mottaket → LAYER_CONSUMED. Uten salg: OK, PO tilbake til sent
select t.item('KNIV-1');
select t.item('KNIV-2');
do $$
declare r jsonb; po jsonb; gr uuid;
begin
  r := t.receive('KNIV-1', 10, 100);
  perform inv.record_sale('{"ref_id":"S1","lines":[{"sku":"KNIV-1","qty":3}]}');
  perform t.expect_error(format('select inv.reverse_goods_receipt(%L)', r->>'id'), 'LAYER_CONSUMED');
  perform t.expect_error(format('select inv.reverse_movement(%s)', r->'movements'->0->>'id'), 'LAYER_CONSUMED');

  r := t.receive('KNIV-2', 10, 100);
  gr := (r->>'id')::uuid;
  perform t.eq(r->'purchase_order'->>'status', 'received', 'po received');
  r := inv.reverse_goods_receipt(gr, 'test', 'feil mottak');
  perform t.eq(r->>'status', 'reversed', 'receipt reversed');
  perform t.eq(t.on_hand('KNIV-2'), 0.000, 'on_hand 0');
  po := inv._po_json((r->>'po_id')::uuid);
  perform t.eq(po->>'status', 'sent', 'po back to sent');
  perform t.eq((po->'lines'->0->>'qty_received')::numeric, 0.000, 'qty_received 0');
  perform t.expect_error(format('select inv.reverse_goods_receipt(%L)', gr), 'ALREADY_REVERSED');
  perform t.integrity();
end $$;

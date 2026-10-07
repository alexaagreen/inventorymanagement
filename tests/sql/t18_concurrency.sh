#!/usr/bin/env bash
# T18: To samtidige new_qty:5 når on_hand 3 → første +2, andre delta 0. on_hand 5.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$ROOT/scripts/db-reset.sh"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/_helpers.sql" \
  -c "select t.item('KNIV-1'); select t.receive('KNIV-1', 3, 100);" >/dev/null
# Sesjon A holder låsen i 2 sekunder før commit
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL &
begin;
select inv.create_adjustment('{"reason":"telling","by":"A","lines":[{"sku":"KNIV-1","new_qty":5}]}');
select pg_sleep(2);
commit;
SQL
sleep 0.5
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "select inv.create_adjustment('{\"reason\":\"telling\",\"by\":\"B\",\"lines\":[{\"sku\":\"KNIV-1\",\"new_qty\":5}]}');" >/dev/null
wait
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/_helpers.sql" <<'SQL'
do $$
begin
  perform t.eq(t.on_hand('KNIV-1'), 5.000, 'on_hand 5');
  perform t.eq((select count(*) from inv.movement where type = 'adjustment_in')::int, 1, 'one movement');
  perform t.eq((select qty_delta from inv.adjustment_line l join inv.adjustment a on a.id = l.adjustment_id where a.created_by = 'B'), 0.000, 'B delta 0');
  perform t.integrity();
end $$;
SQL

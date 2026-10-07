#!/usr/bin/env bash
# Kjører SQL-akseptansetestene (spec §10). Hver testfil får en fersk database.
#   DATABASE_URL=postgres://postgres@localhost:54322/postgres scripts/test-sql.sh [filter]
set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILTER="${1:-}"
pass=0; fail=0; failed=()
for f in "$ROOT"/tests/sql/t*.sql; do
  name="$(basename "$f" .sql)"
  [[ -n "$FILTER" && "$name" != *"$FILTER"* ]] && continue
  "$ROOT/scripts/db-reset.sh" || { echo "db-reset failed"; exit 1; }
  if out=$(psql "$DATABASE_URL" -q -o /dev/null -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/_helpers.sql" -f "$f" 2>&1); then
    echo "  ✓ $name"; pass=$((pass+1))
  else
    echo "  ✗ $name"; echo "$out" | sed 's/^/      /' | tail -15; fail=$((fail+1)); failed+=("$name")
  fi
done
# Samtidighetstest (T18) kjøres separat — trenger to sesjoner
if [[ -z "$FILTER" || "t18" == *"$FILTER"* ]]; then
  if "$ROOT/tests/sql/t18_concurrency.sh"; then echo "  ✓ t18_concurrency"; pass=$((pass+1));
  else echo "  ✗ t18_concurrency"; fail=$((fail+1)); failed+=("t18_concurrency"); fi
fi
echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]

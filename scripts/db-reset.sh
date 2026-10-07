#!/usr/bin/env bash
# Dropper schema `inv` og kjører alle migrasjoner på nytt mot $DATABASE_URL.
# Brukes lokalt og i CI. ALDRI mot produksjon.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
case "$DATABASE_URL" in
  *pooler.supabase.com*|*supabase.co*)
    if [ "${ALLOW_REMOTE_RESET:-}" != "yes" ]; then
      echo "Refusing to reset a remote Supabase database (set ALLOW_REMOTE_RESET=yes to override)." >&2
      exit 1
    fi ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "drop schema if exists inv cascade; drop schema if exists t cascade;" >/dev/null
for f in "$ROOT"/migrations/*.sql; do
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

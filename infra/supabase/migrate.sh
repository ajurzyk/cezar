#!/bin/sh
# Applies packages/gui/supabase/migrations/*.sql in order, tracking which
# files have already run in `public._cezar_migrations` so re-running `db:start`
# is a no-op. `db:reset` blows away the volume → table goes away → all
# migrations re-apply from scratch.
#
# Each migration is wrapped in BEGIN/COMMIT via `--single-transaction` so a
# mid-file failure leaves the tracker untouched.

set -e

PSQL="psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1"
export PGPASSWORD=postgres

$PSQL <<'EOSQL'
create table if not exists public._cezar_migrations (
  filename    text primary key,
  applied_at  timestamptz not null default now()
);
EOSQL

cd /migrations
for f in $(ls *.sql | sort); do
  already=$($PSQL -tA -c "select 1 from public._cezar_migrations where filename = '$f'")
  if [ "$already" = "1" ]; then
    echo "-- skip $f (already applied)"
    continue
  fi
  echo "-- applying $f"
  $PSQL --single-transaction -f "$f"
  $PSQL -c "insert into public._cezar_migrations (filename) values ('$f')"
done
echo "-- migrations done"

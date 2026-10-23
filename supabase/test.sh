#!/usr/bin/env bash
# Spins up a throwaway Postgres, applies schema.sql and runs the checks, including a real
# concurrency test: 30 separate connections race for the last place in the combined pool.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
DIR="$(mktemp -d)"
PORT=55432
AS=""
if [ "$(id -u)" = "0" ]; then chown postgres "$DIR"; AS="runuser -u postgres --"; fi
cleanup() { $AS "$BIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
$AS "$BIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
$AS "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c max_connections=100" -l "$DIR/log" start -w >/dev/null
PSQL="psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -c 'create database rw' >/dev/null
$PSQL -d rw -f "$HERE/test-shim.sql" >/dev/null
PGOPTIONS="-c client_min_messages=warning" $PSQL -d rw -f "$HERE/schema.sql" >/dev/null
$PSQL -d rw -f "$HERE/test.sql" 2>&1 | sed -n 's/.*NOTICE:  //p'

# Concurrency: reset, fill 33 places, then race 30 connections for place 34.
$PSQL -d rw -c "truncate payments, charges, provider_events, lodge_requests, buddy_matches, stock_items, registrations, sponsorships cascade" >/dev/null
$PSQL -d rw -c "do \$\$ begin for i in 1..33 loop perform reserve_registration(t_person('other', 1000 + i)); end loop; end \$\$" >/dev/null
for i in $(seq 1 30); do
  $PSQL -d rw -c "select reserve_registration(t_person('other', 2000 + $i))" >/dev/null &
done
wait
RES=$($PSQL -d rw -At -c "select count(*) filter (where status in ('reserved','confirmed')) || ' ' || count(*) filter (where status = 'waitlisted') from registrations where pool = 'combined'")
set -- $RES
if [ "$1" = "34" ] && [ "$2" = "29" ]; then echo "PASS 30 simultaneous requests for the last place: 1 reserved, 29 waitlisted (34 held in total)"; else echo "FAIL concurrency: held=$1 waitlisted=$2"; exit 1; fi

# Same race for one water point.
for i in $(seq 1 20); do
  $PSQL -d rw -c "select reserve_water_point('{\"client_request_id\":\"race$i\",\"point\":4,\"name\":\"S$i\",\"contact_person\":\"x\",\"email\":\"x@x.org\",\"phone\":\"011\"}')" >/dev/null 2>&1 &
done
wait
N=$($PSQL -d rw -At -c "select count(*) from sponsorships where point = 4")
if [ "$N" = "1" ]; then echo "PASS 20 simultaneous sponsors for one water point: exactly 1 succeeded"; else echo "FAIL water point race: $N"; exit 1; fi

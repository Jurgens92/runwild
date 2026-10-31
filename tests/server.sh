#!/usr/bin/env bash
# Runs the live API (supabase/functions/_shared/server.js) against a throwaway Postgres:
# applies supabase/setup.sql, then tests/server.test.mjs. Needs Postgres installed locally
# (initdb/pg_ctl); on Linux it is found under /usr/lib/postgresql/*/bin.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$BIN/initdb" ] || BIN="$(dirname "$(command -v initdb)")"
DIR="$(mktemp -d)"
PORT=55433
AS=""
if [ "$(id -u)" = "0" ]; then chown postgres "$DIR"; AS="runuser -u postgres --"; fi
cleanup() { $AS "$BIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
$AS "$BIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
$AS "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c max_connections=100" -l "$DIR/log" start -w >/dev/null
PSQL="psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -c 'create database rw' >/dev/null
# The roles Supabase's public API uses, so the test can prove they are locked out.
$PSQL -d rw -c "create role anon nologin; create role authenticated nologin;" >/dev/null
PGOPTIONS="-c client_min_messages=warning" $PSQL -d rw -f "$ROOT/supabase/setup.sql" >/dev/null
PGHOST="$DIR" PGPORT=$PORT PGUSER=postgres PGDATABASE=rw node "$HERE/server.test.mjs"

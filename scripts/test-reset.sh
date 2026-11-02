#!/usr/bin/env bash
# Recreates the local test database from scratch: roles, schema, demo data. Local testing only.
set -euo pipefail
PSQL="psql -v ON_ERROR_STOP=1 -h ${PGSOCKET:-/home/claude/pgrun} -p ${PGPORT_TEST:-5544} -U postgres"
su claude -c "$PSQL -q -c 'DROP DATABASE IF EXISTS cysoc_portal' -c 'DROP ROLE IF EXISTS portal_app' -c 'DROP ROLE IF EXISTS portal_owner'"
su claude -c "PORTAL_OWNER_PASSWORD=ownerpw PORTAL_APP_PASSWORD=apppw $PSQL -q -f docker/db-init.sql" >/dev/null
DATABASE_OWNER_URL=postgres://portal_owner:ownerpw@127.0.0.1:5544/cysoc_portal node dist/server/src/scripts/migrate.js >/dev/null
rm -rf "$STORAGE_DIR"
DEMO_PASSWORD="$DEMO_PASSWORD" node dist/server/src/scripts/seed-demo.js >/dev/null
echo "test database reset"

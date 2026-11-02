# Running the tests

The API and integration tests need a PostgreSQL 16 server you can reset. They create roles, a database and demo data.

```bash
# 1. Start PostgreSQL locally (or point the variables at a disposable server)
# 2. Create roles and database, migrate and seed:
export DATABASE_URL=postgres://portal_app:apppw@127.0.0.1:5544/cysoc_portal
export MASTER_KEY=$(openssl rand -base64 32) COOKIE_SECURE=false PUBLIC_URL=http://127.0.0.1:8090 PORT=8090
export INTEGRATION_MODE=demo STORAGE_DIR=/tmp/portal-reports WEB_DIR=./dist/web DEMO_PASSWORD='Demo-Portal-2026!'
npm run build
./scripts/test-reset.sh            # adjust PSQL connection inside for your server

# 3. API tests (start their own server process)
node --test --import tsx --test-concurrency=1 test/api.test.ts

# 4. Integration tests (fake NTS, Grafana, SMTP, SMS and ClamAV run inside the test)
./scripts/test-reset.sh && node --test --import tsx --test-concurrency=1 test/integrations.test.ts

# 5. Browser run-through (needs Playwright with Chromium)
./scripts/test-reset.sh && (npm start &) && node test/e2e.mjs
```

Reset the database before each suite; the tests change data.

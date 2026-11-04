#!/usr/bin/env bash
# Creates .env with strong random secrets. Usage: ./scripts/setup-env.sh https://portal.example.com [demo|live]
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:-}"; MODE="${2:-live}"
if [[ ! -f .env.example ]]; then echo ".env.example is missing. Unpack the package with: sudo unzip -o cysoc-portal-<version>.zip -d /opt"; exit 1; fi
if [[ ! "$URL" =~ ^https://[^/]+$ ]]; then
  echo "Give the portal address exactly as users will type it, with https:// and no trailing slash."
  echo "Example: ./scripts/setup-env.sh https://cysoc-portal.time.com.my"
  exit 1
fi
if [[ "$MODE" != "live" && "$MODE" != "demo" ]]; then echo "Mode must be live or demo."; exit 1; fi
if [[ -f .env ]]; then echo ".env already exists. Move it away first if you really want new secrets (existing data needs the old MASTER_KEY)."; exit 1; fi
umask 077
sed -e "s#^PUBLIC_URL=.*#PUBLIC_URL=${URL}#" \
    -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(openssl rand -hex 24)#" \
    -e "s#^PORTAL_OWNER_PASSWORD=.*#PORTAL_OWNER_PASSWORD=$(openssl rand -hex 24)#" \
    -e "s#^PORTAL_APP_PASSWORD=.*#PORTAL_APP_PASSWORD=$(openssl rand -hex 24)#" \
    -e "s#^MASTER_KEY=.*#MASTER_KEY=$(openssl rand -base64 32)#" \
    -e "s#^INTEGRATION_MODE=.*#INTEGRATION_MODE=${MODE}#" \
    .env.example > .env.tmp
mv .env.tmp .env
chmod 600 .env
echo "Created .env for ${URL} (${MODE} mode). Copy the MASTER_KEY line into your password vault now:"
grep '^MASTER_KEY=' .env

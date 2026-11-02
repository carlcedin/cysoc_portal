#!/usr/bin/env bash
# Temporary self-signed certificate for testing only. Browsers will warn until you install a real certificate.
# Usage: ./scripts/self-signed-cert.sh cysoc-portal.example.com [server-ip]
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:?Give the host name users will type, e.g. cysoc-portal.example.com}"
IP="${2:-}"
SAN="DNS:${NAME}"; [[ -n "$IP" ]] && SAN="${SAN},IP:${IP}"
[[ "$NAME" =~ ^[0-9.]+$ ]] && SAN="IP:${NAME}"
mkdir -p docker/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=${NAME}" -addext "subjectAltName=${SAN}" \
  -keyout docker/certs/portal.key -out docker/certs/portal.crt 2>/dev/null
chmod 644 docker/certs/portal.crt; chmod 600 docker/certs/portal.key
echo "Self-signed certificate for ${SAN} written to docker/certs (valid 90 days)."

# CySOC Customer Portal

A multi-tenant portal for CySOC and its managed security customers. CySOC staff work every tenant; each customer sees only their own data.

| Area | What it does |
|---|---|
| Escalations | Tracks each SIEM alert from NTS triage to customer acknowledgement, remediation and closure. Email and SMS notifications, one-click acknowledge link, discussion thread synced to the NTS ticket. |
| Security dashboard | Events per second against licence, alerts by severity, MITRE ATT&CK tactics, top rules and log source health, queried from each tenant's Grafana. |
| Scorecard | CySOC's own SLA (detection to customer notification) and the customer's acknowledgement SLA, by severity and by month. |
| Requests | Customers raise allowlist, onboarding, tuning, scan and report requests; each becomes an NTS ticket. |
| Reports | CySOC uploads reports per customer; customers download them; every download is logged. |
| Service and contacts | Subscribed services, licence, log source onboarding, SLA targets, and customer-managed escalation contacts with a 90-day review. |
| Audit log | Every sign-in, acknowledgement, download and change, append-only, optionally forwarded to QRadar. |
| Customer health | Risk score per tenant with renewal and upsell signals (staff only). |
| Administration | API connections, user accounts, tenants and SLA targets. |

## Account types

| | Full Admin | Analyst | Customer |
|---|---|---|---|
| Tenants visible | All | All | Own only |
| Escalation status updates | Yes | Yes | Acknowledge and remediation steps |
| Upload or withdraw reports | Yes | No | No |
| Edit escalation contacts | Any tenant | Send reminders only | Own tenant |
| API configuration | Edit | View only | No access |
| User accounts, tenants, SLA targets | Manage | No | No |

The same matrix is shown in the portal under Administration and comes from `server/src/auth/permissions.ts`.

## How it is built

```
Browser ──HTTPS──> nginx (TLS, rate limits) ──> portal app (Node.js) ──> PostgreSQL (row-level security)
                                                     │
                                       worker ──────┼──> NTS Freshservice API (poll tickets, write back notes and status)
                                                     ├──> Grafana API per tenant (dashboard queries, server-side only)
                                                     ├──> SMTP relay and SMS gateway (notifications)
                                                     └──> QRadar syslog (audit events as LEEF)
```

- **Server:** TypeScript on Node.js 22 using only the standard library plus the `pg` PostgreSQL driver. No web framework, which keeps the third-party code you need to review very small.
- **Front end:** React, styled with the Time brand (Sans of Time and Work Sans served locally, no external font or script hosts).
- **Tenant isolation is enforced twice.** The API filters by tenant, and PostgreSQL row-level security policies refuse other tenants' rows even if a query is wrong. The application connects as a role that cannot bypass those policies.
- **Sign-in:** password (scrypt) plus authenticator-app MFA for every account, with lockout, session timeouts and forced change of temporary passwords.

## Quick start: evaluate with demo data

Needs Docker with Compose on a Linux host.

```bash
sudo ./scripts/setup-env.sh https://<this host> demo
sudo ./scripts/self-signed-cert.sh <this host>
sudo docker compose up -d --build
sudo docker compose run --rm -e DEMO_PASSWORD='Choose-A-Demo-Pass-1' app node dist/server/src/scripts/seed-demo.js
```

Open the portal and sign in as `admin@cysoc.example`, `analyst@cysoc.example` or a customer such as `aisyah@seri.example`, all with the demo password. Each account enrols an authenticator app on first sign-in.

## Production

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: real TLS certificate, `INTEGRATION_MODE=live`, create the first Full Admin with `create-admin`, add tenants, then connect NTS, Grafana, email and SMS under Administration using [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Review [docs/SECURITY.md](docs/SECURITY.md) with your security team and arrange a penetration test before customers are given access.

## Development and tests

```bash
npm install
npm run build            # server (tsc) and front end (esbuild)
npm test                 # API tests; npm run test:integrations for integrations (PostgreSQL needed, see test/README.md)
node test/e2e.mjs        # browser run-through with Playwright against a running demo instance
```

| Suite | Covers |
|---|---|
| `test/api.test.ts` (22 tests) | Sign-in, MFA enrolment and replay protection, lockout (password and MFA), temporary passwords, each account type's permissions, tenant isolation through the API, triage hidden from customers, CSRF, security headers, append-only audit log, acknowledge links, uploads and type checks, contacts, requests, scorecard, dashboard, health |
| `test/integrations.test.ts` (7 tests) | NTS sync and filtering, NTS write-back, request tickets, outbox retries with back-off, Grafana queries and data-frame normalisation, email over STARTTLS with AUTH, SMS, ClamAV verdicts |
| `test/e2e.mjs` (45 checks) | Every tab as each account type in a real browser, key actions, phone-width layout, no browser errors |

## Project layout

```
server/src/
  index.ts, worker.ts        web server and background worker
  config.ts                  environment settings
  http/core.ts               routing, cookies, security headers, CSRF and rate limits
  auth/                      passwords, TOTP, sessions, permissions
  db/                        connection, migrations (SQL with row-level security)
  services/                  escalations, insights (dashboard, scorecard, health), requests and reports, service and admin
  integrations/              NTS, Grafana, storage and ClamAV, email and SMS
  scripts/                   migrate, create-admin, seed-demo
web/src/                     React front end (views per tab), QR code for MFA enrolment
docker/                      database init script, nginx configuration, certificate folder
docs/                        deployment, integrations, security
test/                        API, integration and browser tests
```

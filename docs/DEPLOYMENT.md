# Deploying the CySOC portal

This is the short reference. For a full click-by-click walkthrough on a fresh Ubuntu 24.04 server, use the CySOC Portal Installation Guide (Ubuntu 24.04).

## 1. Server

- Linux VM, 4 vCPU, 8 GB RAM, 100 GB disk to start (reports and database grow over time).
- Docker Engine 24+ with the Compose plugin.
- Inbound: TCP 443 from customers (internet, through your WAF) and staff networks. TCP 80 only redirects to 443.
- Outbound from the server: your NTS Freshservice URL, each tenant's Grafana, the SMTP relay, the SMS gateway and the QRadar syslog collector.
- Place it in a DMZ segment; the database is on an internal Docker network and is never exposed.

## 2. Get the code and build the image

The build downloads Node packages from the npm registry. If the server has no internet access, build the image on a build host and move it with `docker save` / `docker load`.

```bash
git clone <your repository> cysoc-portal && cd cysoc-portal
docker compose build
```

After the first build, commit the generated `package-lock.json` so later builds use exactly the same package versions.

## 3. Configure

```bash
sudo ./scripts/setup-env.sh https://cysoc-portal.example.com        # add "demo" as a second argument for an evaluation server
```

It writes `.env` (mode 600) with random database passwords and `MASTER_KEY`, and prints the key. Store a copy of `MASTER_KEY` in your password vault: it encrypts MFA secrets and integration credentials.

## 4. TLS certificate

Put the certificate chain and key in `docker/certs/portal.crt` and `docker/certs/portal.key`. For a quick test, `sudo ./scripts/self-signed-cert.sh <host name> [server ip]` creates a temporary self-signed pair.

## 5. Start

```bash
docker compose up -d
docker compose ps          # db healthy, migrate exited 0, app and worker running, nginx up
docker compose logs -f app worker
```

The `migrate` service applies database changes on every start and grants the application role only what it needs.

To scan uploaded reports for malware, set `CLAMAV_HOST=clamav` in `.env` and start with `docker compose --profile clamav up -d`.

## 6. First Full Admin

```bash
docker compose run --rm app node dist/server/src/scripts/create-admin.js --email you@time.com.my --name "Your Name"
```

It prints a temporary password once. Sign in, enrol your authenticator app, and choose a new password.

## 7. Set up tenants, staff and customers

In the portal, under **Administration**:

1. **Tenants:** add each customer. The **code** must match the customer value your NTS tickets carry (see the NTS section in INTEGRATIONS.md). Add licensed EPS or assets, subscribed services, renewal date and contracted log sources.
2. **SLA targets:** enter your contract values. They drive the scorecard, the register's acknowledgement clock and customer health.
3. **User accounts:** create Analyst and Full Admin accounts for your team, and Customer accounts for each customer's contacts. Each new account gets a one-time temporary password; send it through a different channel from the email address (for example SMS or a phone call).
4. Ask each customer to add their escalation contacts under **My service**, or add them yourself as a Full Admin.

## 8. Connect the integrations

Under **Administration > API configuration**, set the endpoint, secret and settings for NTS, each tenant's Grafana, the email relay and the SMS gateway, then use **Test** on each. Details are in [INTEGRATIONS.md](INTEGRATIONS.md).

## 9. Before customers get access

- Run a penetration test focused on tenant isolation, authentication and file upload.
- Confirm the QRadar log source receives portal audit events.
- Run a backup and a test restore (below).
- Pilot with one or two customers before rolling out.

## Operations

**Backups (daily):**

```bash
docker compose exec -T db pg_dump -U postgres -Fc cysoc_portal > backup/portal-$(date +%F).dump
docker run --rm -v cysoc-portal_reports:/data -v "$PWD/backup":/backup alpine tar czf /backup/reports-$(date +%F).tgz -C /data .
```

Keep `.env` (with `MASTER_KEY`) backed up separately in your vault. Test a restore every quarter.

**Upgrades:** pull the new version, `docker compose build`, `docker compose up -d`. Migrations run automatically.

**Logs:** `docker compose logs app worker nginx`. Audit events go to the `audit_log` table and, if configured, to QRadar.

**Unlock a user or reset MFA:** Administration > User accounts > Reset password (also unlocks) or Reset MFA.

**Worker:** run exactly one `worker` container. It retries failed NTS, email and SMS deliveries with back-off (2, 4, 8, 16, 32 minutes, then hourly) for about eight hours, then marks them failed; failed items stay in the `outbox` table with the error for review.

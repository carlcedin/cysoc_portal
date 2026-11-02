# Security design

The portal holds customer escalation details, monitoring data and reports for an NCII entity, and is reachable by customers over the internet. These are the controls built in, and what remains for you to do.

## Tenant isolation

- **Database row-level security.** Every tenant table has a policy that only returns rows for the tenant in the request's context. The application connects as `portal_app`, which cannot bypass these policies. A coding mistake that forgets a tenant filter returns nothing rather than another customer's data.
- **Context per request.** Each API request runs in a transaction that sets the caller's role and tenant from the server-side session. Customers cannot choose a tenant; the `tenant` parameter is ignored for them.
- **Triage is hidden.** Customers cannot see escalations still in CySOC triage, nor messages on them. This is enforced in the policy, not only in queries.
- **Files.** Reports are stored per tenant and only served through the API after the same checks. Storage paths are never accepted from the client.
- Tested by `test/api.test.ts` (cross-tenant reads, actions, messages, downloads and contact deletion are refused) and by direct SQL checks as the application role.

## Authentication and sessions

- Passwords hashed with scrypt (N=32768). Minimum 12 characters with three character classes. Temporary passwords from admins must be changed at first sign-in.
- MFA is mandatory for every account (TOTP authenticator app, enrolled at first sign-in with a QR code). A code cannot be reused. Wrong codes count towards lockout.
- Five failed password or MFA attempts lock the account for 15 minutes and end its sessions. Failed attempts and locks are audited.
- The same error message for unknown email and wrong password, with equal timing.
- Sessions: random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, stored only as a SHA-256 hash. 30-minute idle timeout, 12-hour maximum. Password change and lockout end other sessions.
- Rate limits in the app (per IP, per email, per session) and again in nginx.

## Web protections

- CSRF: every state-changing API call needs a custom header and a matching `Origin`, on top of `SameSite=Strict` cookies.
- Content Security Policy allows scripts, fonts and connections only from the portal itself; framing is denied.
- `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`.
- All output is escaped by React; server-rendered pages escape every value.
- Uploads: extension allowlist, file signature check, size limit, optional ClamAV scan, stored outside the web root, downloaded as attachments.

## Email acknowledge links

- The link token is derived with HMAC from `MASTER_KEY`, so the raw token is never stored. Only its hash is kept, with a 72-hour expiry.
- Opening the link shows a confirmation page; only the button acknowledges. Mail security scanners that follow links therefore cannot acknowledge on the customer's behalf.
- A token works once and acknowledges only its own escalation.

## Secrets

- Integration credentials and MFA secrets are encrypted with AES-256-GCM using `MASTER_KEY`. Analysts never receive them; Full Admins see only the last four characters.
- Database passwords and `MASTER_KEY` live in `.env` with mode 600. Keep a copy of `MASTER_KEY` in your vault.

## Audit

- Every sign-in, failed attempt, lock, acknowledgement, message, download, upload, configuration and account change is recorded with user, side, tenant, time and IP.
- The audit table is append-only: a trigger rejects updates and deletes, and the application role has no update or delete rights on it.
- Optional real-time forwarding to QRadar as LEEF.

## Containers and network

- App and worker run as a non-root user, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`.
- The database and app are on an internal Docker network; only nginx publishes ports. TLS 1.2 and 1.3 only.
- Small dependency footprint: the server uses Node's standard library plus `pg`. Commit `package-lock.json` and scan dependencies in your pipeline.

## What you still need to do

1. **Penetration test** before customer access, focusing on tenant isolation, authentication, upload handling and the acknowledge link.
2. **WAF and DDoS protection** in front of nginx for the internet-facing name.
3. **Backups** of the database, the reports volume and `.env`, with tested restores.
4. **Patch cadence** for the base images (`node:22-bookworm-slim`, `postgres:16`, `nginx`, `clamav`) and dependencies.
5. **Data protection review (PDPA):** customer contact names, emails and phone numbers are personal data. Confirm retention periods, especially for the audit log and closed escalations, and update the customer agreement if needed.
6. **Monitoring:** alert on the portal's own health check, worker errors and audit events in QRadar.
7. **Single sign-on (later):** staff could move to Entra ID; customers could use a separate identity provider. The session layer is built so this can be added without changing permissions.

## Known limits of this release

- Rate limits are per process; they are complete for a single app container. If you run several, rely on nginx limits or add a shared store.
- Grafana results are cached in memory per process for 60 seconds.
- MFA is authenticator-app only (no SMS codes, which are weaker, and no hardware keys yet).

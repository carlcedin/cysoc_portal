# Changes

## 1.2.1
- Every table with more than 10 rows is split into pages: 10 rows by default, with Previous/Next, page numbers and a choice of 25, 50 or 100 rows per page. Changing a filter returns to page 1.

## 1.2.0
- Bulk customer import under Administration > Tenants > Import customers: paste rows copied from Excel or choose a CSV file, tick the categories every row gets, check the preview, then import. Existing customers (matched by code or name) gain the new categories instead of being duplicated; bad rows are skipped and listed. Up to 3,000 rows at a time.
- Customers can have no SIEM (for example DDoS only). They get no Grafana connection, are left out of the combined security dashboard, and their workspace explains there is no SIEM dashboard.

## 1.1.0
- Customer categories: TSAM, TMDR, DDoS, TSN, TSN+, VA, PAM. A customer can belong to several; set them under Administration > Tenants.
- Staff now land on **Customers**: choose a category, see its customers with open escalations, awaiting and overdue acknowledgements, open requests, last report and renewal; click a customer to open its workspace.
- Customer workspace: tickets and escalations, security dashboard, scorecard, requests, reports, service and contacts, and audit log for that customer only, with a back button and a customer switcher.
- Migration 003 adds the categories and fills them in where existing data is clear (TSAM, TMDR, DDoS, VA, PAM).

## 1.0.3
- `MFA_REQUIRED` setting in `.env` (default `true`). When `false`, accounts sign in with a password only; staff see a warning banner, the server logs a warning, and each sign-in is audited as password-only.

## 1.0.2
- Portal containers can reach NTS, Grafana, email and SMS (they were on an internal-only network).
- nginx looks the app up again after it is recreated (no more 502 after restarts).
- HTTPS and HTTP ports set in `.env` (`PORTAL_HTTPS_PORT`, `PORTAL_HTTP_PORT`), for servers where 443 is already used.
- Optional Grafana stack in `grafana/`, reachable from the portal as `http://grafana:3000`.
- Integration errors name the real cause (DNS, timeout, refused, certificate) instead of "fetch failed".
- NTS endpoint ending in `/api/v2` is refused with an explanation.
- MFA: a reused code says so and no longer counts towards account lockout.
- `setup-env.sh` stops with a clear message when `.env.example` is missing, instead of leaving an empty `.env`.

## 1.0.1
- Setup scripts for `.env` and a temporary certificate; database start-up retries; esbuild server build.

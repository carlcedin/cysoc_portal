# Integration guide

All connections are set under **Administration > API configuration** by a Full Admin. Secrets are encrypted with `MASTER_KEY` and never shown again after saving. Every change and test is recorded in the audit log.

## NTS (Freshservice)

**Endpoint:** your Freshservice base URL, for example `https://nts.freshservice.com`.
**Secret:** the API key of a dedicated service agent. Give that agent access only to the SOC groups.

### What the worker does

Every minute (`WORKER_INTERVAL_SECONDS`) the worker:

1. Reads tickets updated since the last run: `GET /api/v2/tickets?updated_since=…`.
2. Keeps tickets in the configured groups whose customer field matches a tenant **code**.
3. Creates a portal escalation in **triage** (visible to CySOC only) for each new ticket. A ticket resolved or closed in NTS while still in triage is closed in the portal too, so false positives never reach the customer.
4. Sends queued changes back to NTS:
   - escalate to customer → ticket status set to `statusOnEscalate` and a private note
   - customer acknowledgement, remediation, closure request and portal messages → private notes
   - verify and close → status `statusOnClose` and a note
   - customer service request → a new ticket in `requestGroupId`

### Settings (JSON)

```json
{
  "tenantField": "cf_customer_code",
  "groupIds": [27000012345],
  "detectedField": "cf_detected_at",
  "sourceField": "cf_siem",
  "priorityMap": { "4": "Critical", "3": "High", "2": "Medium", "1": "Low" },
  "statusOnEscalate": 3,
  "statusOnClose": 4,
  "closedStatuses": [4, 5],
  "requestGroupId": 27000012399,
  "requesterEmail": "cysoc@time.com.my"
}
```

| Setting | Meaning |
|---|---|
| `tenantField` | Custom field on the ticket holding the tenant code (create it in Freshservice if it does not exist, and have your SIEM-to-NTS rule fill it). Required. |
| `groupIds` | Only tickets in these groups are imported. Empty imports all groups, which is not recommended. |
| `detectedField` | Optional field with the SIEM detection time. Without it the ticket creation time is used, which makes the scorecard slightly favourable to CySOC. |
| `sourceField` | Optional field naming the SIEM (QRadar or Antarex). |
| `priorityMap` | Freshservice priority (1 Low to 4 Urgent) to portal severity. |
| `statusOnEscalate` / `statusOnClose` | Freshservice status IDs to set (3 Pending, 4 Resolved by default). |
| `closedStatuses` | Statuses that mean the ticket is finished in NTS. |
| `requestGroupId`, `requesterEmail` | Where customer service requests are created, and the requester used for them. |

Freshservice limits API calls per minute by plan. One poll uses one call per 100 updated tickets, plus one call per queued change. If you see HTTP 429 in the status note, raise `WORKER_INTERVAL_SECONDS`.

## Grafana (one connection per tenant)

A connection named `Grafana · <tenant>` is created with each tenant.

**Endpoint:** that tenant's Grafana URL, for example `https://grafana-seri.cysoc.internal`.
**Secret:** a service account token with the **Viewer** role, created in that tenant's Grafana organisation. The portal only calls `/api/ds/query` and `/api/health`.

The browser never contacts Grafana. The portal server runs one query per panel and caches results for 60 seconds.

### Settings (JSON)

Each panel names a Grafana data source UID and the query model exactly as Grafana's query inspector shows it (the part inside `queries[0]`, without `refId` and `datasource`).

```json
{
  "panels": {
    "eps":     { "datasourceUid": "<uid>", "query": { "rawSql": "SELECT $__timeGroupAlias(event_time, 1h), count(*)/3600.0 AS eps FROM events WHERE $__timeFilter(event_time) GROUP BY 1 ORDER BY 1", "format": "time_series" } },
    "alerts":  { "datasourceUid": "<uid>", "query": { "rawSql": "SELECT $__timeGroupAlias(created, 1h), severity, count(*) AS n FROM offenses WHERE $__timeFilter(created) GROUP BY 1, 2 ORDER BY 1", "format": "table" } },
    "tactics": { "datasourceUid": "<uid>", "query": { "rawSql": "SELECT tactic, count(*) AS n FROM detections WHERE $__timeFilter(created) GROUP BY 1", "format": "table" } },
    "rules":   { "datasourceUid": "<uid>", "query": { "rawSql": "SELECT rule_name, count(*) AS n FROM detections WHERE $__timeFilter(created) GROUP BY 1 ORDER BY 2 DESC LIMIT 8", "format": "table" } },
    "sources": { "datasourceUid": "<uid>", "query": { "rawSql": "SELECT name, type, max(last_event) AS last_seen, avg(eps) AS eps FROM log_sources GROUP BY 1, 2", "format": "table" } }
  }
}
```

The examples are SQL; use whatever query language your data source speaks (PromQL `expr`, OpenSearch/Wazuh `query` and `metrics`, and so on). The portal only cares about the **shape** of the result:

| Panel | Expected result |
|---|---|
| `eps` | Time series of events per second. Several series (for example one per log source) are added together. |
| `alerts` | Either a table with a time column, a `severity` text column and a count, or one numeric series per severity (named or labelled Critical, High, Medium, Low). |
| `tactics`, `rules` | Table with a text column (name) and a number column (count). |
| `sources` | Table with columns `name`, optional `type`, `last_seen` (time) and optional `eps`. A source is shown as delayed after 15 minutes and silent after 6 hours without events. |

Leave a panel out and the dashboard shows "Not configured" for it. Errors appear at the top of the dashboard and in the connection's status note.

For QRadar, the usual route is a Grafana data source over the QRadar Ariel API or an export database; for Antarex (Wazuh), the Wazuh indexer (OpenSearch) data source.

## Email relay (SMTP)

**Endpoint:** `smtp://relay.internal:587` (STARTTLS is used automatically when the relay offers it) or `smtp://relay.internal:465` with `"secure": true`.
**Secret:** SMTP password, if the relay needs authentication.

```json
{ "from": "cysoc-portal@time.com.my", "username": "cysoc-portal", "secure": false, "rejectUnauthorized": true }
```

Email carries escalations (with the acknowledge link), reminders, new report notices and contact review reminders. Use **Test** with your own address to check delivery and spam filtering, and add SPF/DKIM for the sending domain.

## SMS gateway

**Endpoint:** the gateway's HTTPS URL for sending one message.
**Secret:** API key. By default it is sent as `Authorization: Bearer <key>`.

```json
{ "toField": "to", "messageField": "message", "authHeader": "X-API-Key", "extraFields": { "sender": "CySOC" } }
```

The portal POSTs JSON `{ "<toField>": "+60123456789", "<messageField>": "…", ...extraFields }`. SMS goes to contacts whose alert channels include SMS, for Critical and High escalations only.

## QRadar audit forwarding

Set `SYSLOG_HOST`, `SYSLOG_PORT` and `SYSLOG_PROTOCOL` in `.env`. Each audit event is sent as RFC 5424 syslog carrying LEEF 2.0:

```
LEEF:2.0|TIME|CySOC Portal|1.0|<action>|^|devTime=…^usrName=…^src=<client IP>^cat=<CySOC|Customer|System>^tenant=<code>^msg=…
```

In QRadar, add a log source of type **Universal LEEF** for the portal host. Useful rules: repeated `Failed sign-in` or `Account locked`, `Changed API configuration`, `Changed account`, and downloads outside business hours.

## Malware scanning

Start the stack with `--profile clamav` and set `CLAMAV_HOST=clamav`. Uploads are streamed to ClamAV before they are stored; infected files are rejected and the attempt is logged. If the scanner is unreachable the upload is refused rather than stored unscanned.

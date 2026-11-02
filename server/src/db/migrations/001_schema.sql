-- CySOC portal schema. Run by the database owner; the application connects as portal_app.

-- Request context set by the application at the start of every transaction.
CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.role', true), '') $$;
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() IN ('admin', 'analyst', 'system') $$;
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                       -- matches the customer value in NTS
  name text NOT NULL,
  service text NOT NULL,                           -- e.g. TSAM, Antarex MXOC
  siem text NOT NULL,                              -- QRadar or Antarex
  licensed_eps integer,
  licensed_assets integer,
  services text[] NOT NULL DEFAULT '{}',
  monitoring_hours text NOT NULL DEFAULT '24x7',
  renewal_date date,
  contacts_confirmed_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE log_source_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  onboarded boolean NOT NULL DEFAULT false,
  note text
);

CREATE TABLE sla_targets (
  severity text PRIMARY KEY CHECK (severity IN ('Critical','High','Medium','Low')),
  escalate_minutes integer NOT NULL,              -- CySOC: detection to customer notification
  ack_hours numeric NOT NULL,                     -- customer: notification to acknowledgement
  sort integer NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','analyst','customer')),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  mfa_secret_enc text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_last_step bigint,                            -- blocks reuse of a TOTP code
  active boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_has_tenant CHECK ((role = 'customer') = (tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_passed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL DEFAULT '',
  tier text NOT NULL CHECK (tier IN ('Primary','Secondary','After-hours')),
  email text NOT NULL,
  phone text NOT NULL DEFAULT '',
  alert_channels text NOT NULL DEFAULT 'Email',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_tenant ON contacts(tenant_id);

CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nts_ticket_id bigint UNIQUE,
  ref text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('Critical','High','Medium','Low')),
  summary text NOT NULL,
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('triage','escalated','acknowledged','remediating','closed')),
  detected_at timestamptz NOT NULL,
  triaged_at timestamptz,
  escalated_at timestamptz,
  acknowledged_at timestamptz,
  ack_via text,
  remediation_at timestamptz,
  closure_requested_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalations_tenant_status ON escalations(tenant_id, status);
CREATE INDEX escalations_escalated ON escalations(escalated_at);

CREATE TABLE escalation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_id uuid NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  side text NOT NULL CHECK (side IN ('CySOC','Customer')),
  body text NOT NULL CHECK (length(body) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_messages_esc ON escalation_messages(escalation_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escalation_id uuid NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel text NOT NULL,
  recipient_name text NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  ack_token_hash text,
  ack_token_expires timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_esc ON notifications(escalation_id);
CREATE INDEX notifications_token ON notifications(ack_token_hash);

CREATE SEQUENCE service_request_seq START 1001;
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ref text NOT NULL UNIQUE,
  nts_ticket_id bigint,
  type text NOT NULL,
  details text NOT NULL CHECK (length(details) <= 4000),
  raised_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  raised_by_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('Submitted','In progress','Completed')),
  target_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  type text NOT NULL,
  period text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  uploaded_by_name text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE INDEX reports_tenant ON reports(tenant_id);

CREATE TABLE report_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  side text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

-- Append-only: the trigger below rejects UPDATE and DELETE for everyone.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  actor_name text NOT NULL,
  side text NOT NULL,
  tenant_id uuid,
  action text NOT NULL,
  details text NOT NULL DEFAULT '',
  ip text
);
CREATE INDEX audit_tenant_at ON audit_log(tenant_id, at DESC);
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

CREATE TABLE integrations (
  id text PRIMARY KEY,                             -- nts, grafana:<tenant code>, storage, smtp, sms
  kind text NOT NULL,
  name text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint text NOT NULL DEFAULT '',
  auth_label text NOT NULL DEFAULT '',
  secret_enc text,
  secret_last4 text,
  settings jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','warn','error','unknown')),
  status_note text NOT NULL DEFAULT '',
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Outbound changes to NTS, sent by the worker with retries.
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  last_error text
);
CREATE INDEX outbox_pending ON outbox(next_attempt_at) WHERE done_at IS NULL;

-- Latest monitoring figures per tenant, refreshed by the worker for health scoring.
CREATE TABLE tenant_metrics (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  peak_eps_30d numeric,
  avg_eps_30d numeric,
  sources_total integer,
  sources_down integer,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_state (key text PRIMARY KEY, value text NOT NULL);

-- ---------- Row-level security ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['log_source_contracts','contacts','escalations','escalation_messages','notifications',
                           'service_requests','reports','report_downloads','tenant_metrics'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_is_staff() OR tenant_id = app_tenant()) WITH CHECK (app_is_staff() OR tenant_id = app_tenant())', t);
  END LOOP;
END $$;

-- Customers never see escalations still in CySOC triage, nor messages on them.
DROP POLICY tenant_isolation ON escalations;
CREATE POLICY tenant_isolation ON escalations
  USING (app_is_staff() OR (tenant_id = app_tenant() AND status <> 'triage'))
  WITH CHECK (app_is_staff() OR (tenant_id = app_tenant() AND status <> 'triage'));
DROP POLICY tenant_isolation ON escalation_messages;
CREATE POLICY tenant_isolation ON escalation_messages
  USING (app_is_staff() OR (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM escalations e WHERE e.id = escalation_id)))
  WITH CHECK (app_is_staff() OR (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM escalations e WHERE e.id = escalation_id)));

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON tenants FOR SELECT USING (app_is_staff() OR id = app_tenant());
CREATE POLICY tenant_write ON tenants FOR ALL USING (app_role() IN ('admin','system')) WITH CHECK (app_role() IN ('admin','system'));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING (app_is_staff() OR id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY users_write ON users FOR ALL USING (app_role() IN ('admin','system')) WITH CHECK (app_role() IN ('admin','system'));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_system ON sessions USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT USING (app_is_staff() OR tenant_id = app_tenant());
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (app_is_staff() OR tenant_id = app_tenant());

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_read ON integrations FOR SELECT USING (app_is_staff());
CREATE POLICY integrations_write ON integrations FOR ALL USING (app_role() IN ('admin','system')) WITH CHECK (app_role() IN ('admin','system'));

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_insert ON outbox FOR INSERT WITH CHECK (true);
CREATE POLICY outbox_staff ON outbox FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

ALTER TABLE sla_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY sla_read ON sla_targets FOR SELECT USING (true);
CREATE POLICY sla_write ON sla_targets FOR ALL USING (app_role() IN ('admin','system')) WITH CHECK (app_role() IN ('admin','system'));

INSERT INTO sla_targets (severity, escalate_minutes, ack_hours, sort) VALUES
  ('Critical', 15, 1, 0), ('High', 30, 4, 1), ('Medium', 120, 24, 2), ('Low', 480, 72, 3);

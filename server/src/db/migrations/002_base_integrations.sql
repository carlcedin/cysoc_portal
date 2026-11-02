-- Connections every installation has. Grafana rows are added per tenant.
INSERT INTO integrations (id, kind, name, auth_label, settings) VALUES
  ('nts', 'ticketing', 'NTS Freshservice', 'API key',
   '{"tenantField":"cf_customer_code","groupIds":[],"priorityMap":{"4":"Critical","3":"High","2":"Medium","1":"Low"},"statusOnEscalate":3,"statusOnClose":4,"closedStatuses":[4,5]}'),
  ('smtp', 'notifications', 'Email relay', 'SMTP password', '{"from":"cysoc-portal@example.com","username":""}'),
  ('sms', 'notifications', 'SMS gateway', 'API key', '{"toField":"to","messageField":"message"}')
ON CONFLICT (id) DO NOTHING;

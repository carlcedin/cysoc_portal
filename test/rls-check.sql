-- Direct row-level security checks, run as the application role (portal_app) against demo data:
--   psql postgres://portal_app:...@host/cysoc_portal -f test/rls-check.sql
-- Expected: customer sees 1 tenant, 0 rows of other tenants, 0 triage items, 0 integrations, 0 users;
-- the cross-tenant UPDATE affects 0 rows; DELETE on audit_log fails with permission denied.
\set QUIET on
\pset tuples_only on
SELECT set_config('app.role','system',false) \g /dev/null
SELECT id AS seri FROM tenants WHERE code='seri' \gset
BEGIN;
SELECT set_config('app.role','',false) \g /dev/null
SELECT set_config('app.role','customer',true), set_config('app.tenant_id', :'seri', true) \g /dev/null
SELECT 'customer sees tenants:', count(*) FROM tenants;
SELECT 'customer sees escalations of other tenants:', count(*) FROM escalations WHERE tenant_id <> :'seri';
SELECT 'customer sees triage items:', count(*) FROM escalations WHERE status='triage';
SELECT 'customer sees own escalations:', count(*) FROM escalations;
SELECT 'customer sees integrations:', count(*) FROM integrations;
SELECT 'customer sees other users:', count(*) FROM users;
SELECT 'customer sees audit rows of others:', count(*) FROM audit_log WHERE tenant_id IS DISTINCT FROM :'seri';
COMMIT;
BEGIN;
SELECT set_config('app.role','customer',true), set_config('app.tenant_id', :'seri', true) \g /dev/null
SAVEPOINT a;
INSERT INTO contacts (tenant_id,name,tier,email) SELECT id,'x','Primary','x@y.z' FROM tenants LIMIT 0;
UPDATE escalations SET status='closed' WHERE tenant_id <> :'seri';
SELECT 'cross-tenant update rows affected: 0 expected above';
ROLLBACK;
BEGIN;
SELECT set_config('app.role','analyst',true) \g /dev/null
SELECT 'analyst sees tenants:', count(*) FROM tenants;
ROLLBACK;
BEGIN;
SELECT set_config('app.role','admin',true) \g /dev/null
DELETE FROM audit_log WHERE id = 1;
ROLLBACK;

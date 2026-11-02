-- Run once by the PostgreSQL container on first start (see docker-compose.yml).
-- portal_owner owns the schema and runs migrations; portal_app is what the portal connects as.
-- portal_app is not a superuser and cannot bypass row-level security.
\set owner_pw `echo "$PORTAL_OWNER_PASSWORD"`
\set app_pw `echo "$PORTAL_APP_PASSWORD"`
CREATE ROLE portal_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE portal_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE cysoc_portal OWNER portal_owner;
\c cysoc_portal
ALTER SCHEMA public OWNER TO portal_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO portal_app;

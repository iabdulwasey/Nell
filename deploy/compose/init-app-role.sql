-- Provision the restricted application role.
--
-- This is not optional hardening. PostgreSQL superusers ignore row-level
-- security entirely, so an application connecting as the database owner would
-- silently lose tenant isolation. Nell refuses to boot in that configuration;
-- this script creates the role it expects instead.
--
-- The owner role still exists for migrations (which need DDL); the application
-- only ever connects as nell_app.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nell_app') THEN
    -- Password is overridden by NELL_APP_PASSWORD in compose.
    CREATE ROLE nell_app LOGIN PASSWORD 'nell_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- The database name is only known at runtime, and GRANT does not accept an
-- expression there, so this one grant is issued dynamically.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nell_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO nell_app;

-- Rights on tables that exist now, and on everything migrations create later.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nell_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nell_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nell_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nell_app;

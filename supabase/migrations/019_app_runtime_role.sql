-- Least-privilege role for the authenticated dashboard's DB connection.
--
-- Today the app connects via the privileged pooler role (postgres.<ref>), so a
-- leaked DATABASE_URL = full-database compromise. `app_runtime` can only do
-- data operations (SELECT/INSERT/UPDATE/DELETE) on public tables — no DDL, no
-- role/db management, no other schemas. This caps blast radius without any
-- application code change (only the DATABASE_URL value moves to this role).
--
-- Run this migration as the owning role (postgres), so ALTER DEFAULT PRIVILEGES
-- below applies to future tables created by migrations.
--
-- IMPORTANT: set a real password out-of-band (do NOT commit it), then point
-- DATABASE_URL at this role and rotate the old postgres password:
--   ALTER ROLE app_runtime WITH PASSWORD '<strong-secret>';
-- Connect via the Supabase pooler as `app_runtime.<project-ref>`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Placeholder password — rotate immediately with ALTER ROLE (see above).
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_BEFORE_USE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_runtime;

-- Data operations on all current public tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
-- SERIAL/identity columns need sequence access for INSERT ... RETURNING id.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Future tables/sequences created by the owner stay accessible automatically,
-- so a new migration doesn't silently break the app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

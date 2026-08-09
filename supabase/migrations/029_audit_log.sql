-- Append-only audit trail for every mutable table. A single generic trigger
-- function records each INSERT/UPDATE/DELETE with the full old/new row as JSONB,
-- so we can answer "what changed, when, old->new, and who" — and, crucially,
-- preserve the full row of anything that gets hard-deleted.
--
-- Tamper-resistance: the log lives in a dedicated `audit` schema (NOT `public`),
-- because migration 019's `ALTER DEFAULT PRIVILEGES IN SCHEMA public` auto-grants
-- app_runtime DML on every public table — an audit table there would be
-- app-forgeable. Here app_runtime gets only SELECT, and the trigger function is
-- SECURITY DEFINER (runs as the owner), so the runtime role has no path to
-- INSERT/UPDATE/DELETE history directly.
--
-- Actor ("who"): read from the transaction-local `app.actor` GUC, which the app
-- sets via set_config('app.actor', email, true) in the same transaction as the
-- write (see lib/db/actor.ts withActor()). NULL when unset — public endpoints,
-- direct psql, or writes not yet wrapped. Capturing it never blocks the write.
--
-- Run as the owning role (postgres) in the Supabase SQL editor — app_runtime
-- cannot create schemas/functions/triggers. Additive and re-runnable.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.audit_log (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  row_id      TEXT,                       -- NEW.id / OLD.id as text (PKs are SERIAL today)
  action      TEXT        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_row     JSONB,
  new_row     JSONB,
  actor       TEXT,                       -- session.user.email, or NULL if not set
  txid        BIGINT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_row ON audit.audit_log (table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at        ON audit.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor     ON audit.audit_log (actor);

CREATE OR REPLACE FUNCTION audit.log_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp           -- harden SECURITY DEFINER vs search_path hijack
AS $$
DECLARE
  v_actor TEXT  := current_setting('app.actor', true);  -- 2-arg form = NULL-safe when unset
  v_old   JSONB := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new   JSONB := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
BEGIN
  INSERT INTO audit.audit_log (table_name, row_id, action, old_row, new_row, actor, txid)
  VALUES (TG_TABLE_NAME,
          COALESCE(v_new->>'id', v_old->>'id'),
          TG_OP, v_old, v_new,
          NULLIF(v_actor, ''),
          txid_current());
  RETURN NULL;                              -- AFTER trigger: return value ignored
END;
$$;

-- Attach to every app-mutated table. Postgres has no CREATE TRIGGER IF NOT
-- EXISTS, so drop-then-create is the idempotent idiom.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payments','adjustments','refunds','orders','excess_purchase',
    'customers','products','products_indo','countries','events','shipments'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t);
  END LOOP;
END
$$;

-- The app may read its own audit trail but never mutate it. The function being
-- SECURITY DEFINER means app_runtime needs (and gets) NO write grant here.
GRANT USAGE  ON SCHEMA audit    TO app_runtime;
GRANT SELECT ON audit.audit_log TO app_runtime;
-- Deliberately NO INSERT/UPDATE/DELETE on audit.audit_log and NO sequence grant.

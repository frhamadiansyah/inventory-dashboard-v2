-- Operational expenses ledger — per-event trip/operating costs.
--
-- Replaces the "Operational_2026" Google Sheet: one row per expense, tied to an
-- event (the trip it was incurred on). Mirrors the sheet's columns exactly,
-- including its multi-currency model:
--
--   * amount_foreign — the "# VLS" column: the cost in whatever currency it was
--                      paid in. For pure-IDR rows this equals amount_idr.
--   * rate           — the "Kurs" column: IDR per unit of the foreign currency.
--                      1.00 for IDR rows (DEFAULT), e.g. 2431.87 for a CNY row.
--   * amount_idr     — the "IDR" column: the rupiah cost. Normally
--                      round(amount_foreign * rate), but stored independently so
--                      it stays the source of truth (and tolerates rounding /
--                      manual override). INTEGER like payments.amount — single
--                      expenses are millions, far under the int4 ceiling.
--
-- category is a closed set (the dashboard renders a fixed dropdown); the CHECK
-- keeps the data honest. method is free-ish text (card last-4, account label) —
-- the dashboard suggests previously-used values but allows new ones.
--
-- Owner-only feature: enforced in the app (requireOwner + the route is absent
-- from lib/access.ts ADMIN_ROUTES, so it never shows for admins). No extra DB
-- grant beyond migration 019's ALTER DEFAULT PRIVILEGES, which auto-grants
-- app_runtime DML on new public tables.

CREATE TABLE IF NOT EXISTS operational_expenses (
  id             SERIAL PRIMARY KEY,
  event          TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  expense_date   DATE DEFAULT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'Shop'
                   CHECK (category IN ('Flight','Lodging','Cargo','Meal','Transport','Shop')),
  amount_foreign NUMERIC(18,2) NOT NULL DEFAULT 0,
  rate           NUMERIC(18,4) NOT NULL DEFAULT 1,
  amount_idr     INTEGER NOT NULL DEFAULT 0,
  is_settled     BOOLEAN NOT NULL DEFAULT FALSE,
  method         TEXT NOT NULL DEFAULT '',
  remarks        TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_operational_expenses_event ON operational_expenses (event);
CREATE INDEX IF NOT EXISTS idx_operational_expenses_date  ON operational_expenses (expense_date DESC);

-- Audit trigger for the new mutable table (same idiom as 029_audit_log.sql /
-- 032_warehouses.sql). Postgres has no CREATE TRIGGER IF NOT EXISTS, so
-- drop-then-create keeps it idempotent.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['operational_expenses'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t);
  END LOOP;
END
$$;

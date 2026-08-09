-- Yubisayu Inventory Dashboard — Supabase (Postgres) schema
-- Run this against your Supabase project via the SQL editor.

CREATE TABLE countries (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  currency      TEXT NOT NULL DEFAULT '',
  kurs          NUMERIC(12,4) NOT NULL DEFAULT 0,
  cargo_per_kg  INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

-- Shipping origins. A package's ongkir depends on which warehouse it ships from
-- (see customer_warehouse_ongkir + jne_rates.origin_code in migration 032).
CREATE TABLE warehouses (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,    -- also the jne_rates origin tag, e.g. 'CIMAHI'
  name        TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

-- At most one default warehouse.
CREATE UNIQUE INDEX warehouses_one_default ON warehouses (is_default) WHERE is_default;

CREATE TABLE events (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  eta          TEXT NOT NULL DEFAULT '',
  country_id   INTEGER REFERENCES countries(id) ON DELETE RESTRICT,
  -- Which warehouse fulfills this event; drives the per-order ongkir lookup.
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  instagram_id TEXT NOT NULL UNIQUE,
  whatsapp     TEXT NOT NULL DEFAULT '',
  data_diri    TEXT NOT NULL DEFAULT '',
  ekspedisi    TEXT NOT NULL DEFAULT '',
  ongkos_kirim INTEGER NOT NULL DEFAULT 0,
  -- Shipping destination, used to resolve per-warehouse ongkir (migration 034).
  -- kota = kabupaten/kota (matches jne_rates.kab_kota_nama).
  kota         TEXT NOT NULL DEFAULT '',
  kecamatan    TEXT NOT NULL DEFAULT '',
  kode_pos     TEXT NOT NULL DEFAULT '',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_account_holder TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX customers_instagram_normalized_uniq ON customers (lower(replace(instagram_id, '@', '')));

-- Per-(customer, warehouse) shipping rate. Single source of truth for ongkir;
-- the legacy customers.ongkos_kirim column is retained for transition only.
CREATE TABLE customer_warehouse_ongkir (
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  ongkos_kirim  INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, warehouse_id)
);

CREATE TABLE products (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  store           TEXT NOT NULL DEFAULT '',
  price           INTEGER NOT NULL DEFAULT 0,
  gram            INTEGER NOT NULL DEFAULT 0,
  country_id      INTEGER REFERENCES countries(id) ON DELETE RESTRICT,
  valas           NUMERIC(12,2) NOT NULL DEFAULT 0,
  kurs            NUMERIC(12,4) NOT NULL DEFAULT 0,
  cargo_per_kg    INTEGER NOT NULL DEFAULT 0,
  profit_pct      INTEGER NOT NULL DEFAULT 0,
  operational_fee INTEGER NOT NULL DEFAULT 5000,
  packing_fee     INTEGER NOT NULL DEFAULT 5000,
  cost            INTEGER NOT NULL DEFAULT 0,
  profit_fixed    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ,
  UNIQUE (name, store)
);

CREATE INDEX idx_products_name ON products (name);

CREATE TABLE products_indo (
  id         SERIAL PRIMARY KEY,
  product    TEXT NOT NULL,
  store      TEXT NOT NULL DEFAULT '',
  price      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer    TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_price  INTEGER NOT NULL DEFAULT 0,
  unit        INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ,
  unit_buy    INTEGER,
  receipt     TEXT NOT NULL DEFAULT '',
  unit_arrive INTEGER,
  unit_ship   INTEGER,
  unit_hold   INTEGER
);

CREATE INDEX idx_orders_event ON orders (event);
CREATE INDEX idx_orders_customer ON orders (lower(customer));
CREATE INDEX idx_orders_customer_normalized ON orders (lower(replace(customer, '@', '')));
CREATE INDEX idx_orders_event_product ON orders (event, product_id);

CREATE TABLE excess_purchase (
  id            SERIAL PRIMARY KEY,
  event         TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  items         TEXT NOT NULL,
  unit_buy      INTEGER NOT NULL,
  receipt       TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT 'overbuy',
  -- 'overbuy' | 'overship' | 'wrong_product'
  expected_item TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_excess_event_items ON excess_purchase (event, items);
CREATE INDEX idx_excess_reason ON excess_purchase (reason);

CREATE TABLE shipments (
  id                SERIAL PRIMARY KEY,
  event             TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer          TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  shipping_id       TEXT NOT NULL UNIQUE,
  invoicing         TEXT NOT NULL DEFAULT '',
  weight_estimation NUMERIC(10,2) NOT NULL DEFAULT 0,
  ongkir            INTEGER NOT NULL DEFAULT 0,
  ongkir_total      INTEGER NOT NULL DEFAULT 0,
  is_last_shipment  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ,
  tracking_number   TEXT NOT NULL DEFAULT '',
  -- One-time receiving-address override. NULL = use the customer's profile
  -- data_diri (the normal case). Persisted so reprints survive future changes
  -- to the customer's permanent address.
  temp_address      TEXT
);

CREATE INDEX idx_shipments_customer ON shipments (lower(customer));

CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer   TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount     INTEGER NOT NULL DEFAULT 0,
  account    TEXT NOT NULL DEFAULT '',
  is_checked BOOLEAN NOT NULL DEFAULT FALSE,
  pay_date   DATE DEFAULT NULL,
  remarks    TEXT NOT NULL DEFAULT '',
  -- 'deposit' (money in) | 'refund' (cash out) | 'credit' (internal overpayment
  -- transfer). All count toward total_paid; kind is for display + reconciliation.
  kind       TEXT NOT NULL DEFAULT 'deposit' CHECK (kind IN ('deposit', 'refund', 'credit')),
  -- The refund this payment was produced by (cash refund or credit transfer).
  -- FK added after refunds is declared below. NULL for ordinary deposits.
  refund_id  INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_payments_event_customer ON payments (event, lower(customer));
CREATE INDEX idx_payments_customer_normalized ON payments (lower(replace(customer, '@', '')));

CREATE TABLE adjustments (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer    TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX idx_adjustments_event_customer ON adjustments (event, lower(customer));
CREATE INDEX idx_adjustments_customer_normalized ON adjustments (lower(replace(customer, '@', '')));

CREATE TABLE refunds (
  id              SERIAL PRIMARY KEY,
  event           TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer        TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reason          TEXT NOT NULL DEFAULT 'overpayment',
  refund_amount   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  bank_name           TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_account_holder TEXT NOT NULL DEFAULT '',
  transfer_reference  TEXT NOT NULL DEFAULT '',
  payment_id     INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  order_id       INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  affected_units INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_refunds_event_customer ON refunds (event, lower(customer));
CREATE INDEX idx_refunds_status ON refunds (status);
CREATE INDEX idx_refunds_customer ON refunds (lower(customer));

-- At most one ACTIVE auto-detected overpayment refund per (event, customer).
-- Prevents the materializer's check-then-insert from producing duplicates under
-- concurrent /refunds loads (see migration 031).
CREATE UNIQUE INDEX refunds_one_active_overpayment
  ON refunds (event, lower(replace(customer, '@', '')))
  WHERE reason = 'overpayment'
    AND status IN ('pending', 'awaiting_bank_info', 'ready_to_refund');

-- payments.refund_id FK (declared here because refunds is defined after
-- payments). ON DELETE SET NULL: deleting a refund must not remove the money
-- rows it produced.
ALTER TABLE payments
  ADD CONSTRAINT payments_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE SET NULL;
CREATE INDEX idx_payments_refund_id ON payments (refund_id);

-- ─── Audit log (migration 029) ───────────────────────────────────────────────
-- Append-only change history for every mutable table. Lives in its own schema
-- (not public) so migration 019's default-privilege grants don't make it
-- app-writable; the SECURITY DEFINER trigger does the inserts. See
-- supabase/migrations/029_audit_log.sql for the full rationale.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.audit_log (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  row_id      TEXT,
  action      TEXT        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_row     JSONB,
  new_row     JSONB,
  actor       TEXT,
  txid        BIGINT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_table_row ON audit.audit_log (table_name, row_id);
CREATE INDEX idx_audit_log_at        ON audit.audit_log (at DESC);
CREATE INDEX idx_audit_log_actor     ON audit.audit_log (actor);

CREATE OR REPLACE FUNCTION audit.log_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
DECLARE
  v_actor TEXT  := current_setting('app.actor', true);
  v_old   JSONB := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new   JSONB := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
BEGIN
  INSERT INTO audit.audit_log (table_name, row_id, action, old_row, new_row, actor, txid)
  VALUES (TG_TABLE_NAME,
          COALESCE(v_new->>'id', v_old->>'id'),
          TG_OP, v_old, v_new,
          NULLIF(v_actor, ''),
          txid_current());
  RETURN NULL;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payments','adjustments','refunds','orders','excess_purchase',
    'customers','products','products_indo','countries','events','shipments',
    'warehouses','customer_warehouse_ongkir'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I '
      'FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t);
  END LOOP;
END
$$;

GRANT USAGE  ON SCHEMA audit    TO app_runtime;
GRANT SELECT ON audit.audit_log TO app_runtime;

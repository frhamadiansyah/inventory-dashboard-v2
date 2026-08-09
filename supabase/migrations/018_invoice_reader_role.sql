-- Read-only DB role for the PUBLIC, no-login invoice recap endpoint
-- (app/api/public/invoice). The customer-facing site looks up a recap by
-- Instagram handle; this role is scoped so that path can ONLY read what the
-- recap shows — orders, totals, payment status — and NEVER name, WhatsApp,
-- personal data (data_diri), or bank details.
--
-- IMPORTANT: set a real password out-of-band (do NOT commit it), then point
-- INVOICE_READER_DATABASE_URL at this role:
--   ALTER ROLE invoice_reader WITH PASSWORD '<strong-secret>';
-- Connect via the Supabase pooler as `invoice_reader.<project-ref>`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoice_reader') THEN
    -- Placeholder password — rotate immediately with ALTER ROLE (see above).
    CREATE ROLE invoice_reader LOGIN PASSWORD 'CHANGE_ME_BEFORE_USE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Start from zero, then grant only what the recap needs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM invoice_reader;
GRANT USAGE ON SCHEMA public TO invoice_reader;

-- The only tables getPublicInvoiceForCustomer reads.
GRANT SELECT ON orders, products, events, payments, adjustments TO invoice_reader;

-- Customers: ONLY the two columns the recap needs (handle for matching, ongkir
-- rate for the shipping estimate). Column-level grant makes whatsapp / data_diri
-- / ekspedisi / bank_name / bank_account_number / bank_account_holder physically
-- unreadable on this connection.
GRANT SELECT (instagram_id, ongkos_kirim) ON customers TO invoice_reader;

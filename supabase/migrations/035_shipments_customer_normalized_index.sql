-- Functional index for the PUBLIC invoice recap's shipments lookup.
--
-- getPublicInvoiceForCustomer (lib/db/invoice.ts) matches shipments with
--   WHERE lower(replace(customer, '@', '')) = $handle
-- but the only shipments index on customer is idx_shipments_customer, defined
-- on lower(customer) (000_init.sql) — the replace('@','') means the planner
-- can't use it, so every public recap sequential-scans shipments. orders,
-- payments, adjustments and customers already have the matching normalized
-- functional index; shipments is the lone gap. Under an event traffic spike
-- those scans burn CPU (and, post-migration to usage-based Neon compute,
-- money) on every customer request.
--
-- For a large shipments table, prefer the non-blocking form (must run outside
-- a transaction, so paste it as its own statement in the SQL editor):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shipments_customer_normalized
--     ON shipments (lower(replace(customer, '@', '')));
CREATE INDEX IF NOT EXISTS idx_shipments_customer_normalized
  ON shipments (lower(replace(customer, '@', '')));

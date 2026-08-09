-- Grant the public recap's read-only role access to shipments.
-- getPublicInvoiceForCustomer now reads tracking_number + created_at to show
-- resi/ship-date and to derive the "Completed" status. The shipments table has
-- no PII (only the customer handle, weights, ongkir, and tracking numbers), so
-- a full SELECT is consistent with the existing orders/payments grants in
-- migration 018. Re-runnable.

GRANT SELECT ON shipments TO invoice_reader;

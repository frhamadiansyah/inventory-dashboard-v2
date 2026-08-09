-- Per-customer invoice roll-up, so the Customers list can sort by total
-- invoiced and filter by balance status server-side (across all customers, not
-- just the loaded page). Read-only view — no data stored, always live.
--
-- Mirrors getPaymentStatus()'s per-(event, customer) invoice math, then
-- aggregates by the canonical customer key (bare lowercase handle, no '@').
CREATE OR REPLACE VIEW customer_invoice_summary AS
WITH order_aggregates AS (
  SELECT o.event AS event,
         lower(replace(o.customer, '@', '')) AS cust_key,
         SUM(o.unit_price * o.unit) AS subtotal,
         SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
  FROM orders o
  JOIN products p ON p.id = o.product_id
  GROUP BY o.event, lower(replace(o.customer, '@', ''))
),
payment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_paid
  FROM payments
  WHERE is_checked = true
  GROUP BY event, lower(replace(customer, '@', ''))
),
adjustment_aggregates AS (
  SELECT event, lower(replace(customer, '@', '')) AS cust_key, SUM(amount) AS total_adj
  FROM adjustments
  GROUP BY event, lower(replace(customer, '@', ''))
),
customer_ongkir AS (
  -- Per-(event, customer) ongkir from the event's warehouse.
  SELECT ev.name AS event,
         lower(replace(c.instagram_id, '@', '')) AS cust_key,
         COALESCE(cwo.ongkos_kirim, 0) AS ongkos_kirim
  FROM events ev
  JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
  JOIN customers c ON c.id = cwo.customer_id
),
all_keys AS (
  SELECT event, cust_key FROM order_aggregates
  UNION
  SELECT event, cust_key FROM payment_aggregates
  UNION
  SELECT event, cust_key FROM adjustment_aggregates
),
per_invoice AS (
  SELECT
    k.cust_key,
    (COALESCE(oa.subtotal, 0)
      + COALESCE(co.ongkos_kirim, 0) * CEIL(COALESCE(oa.total_gram, 0)::numeric / 1000)
      + COALESCE(adj.total_adj, 0))::int AS invoice_total,
    COALESCE(pa.total_paid, 0)::int AS total_paid
  FROM all_keys k
  LEFT JOIN order_aggregates oa ON oa.event = k.event AND oa.cust_key = k.cust_key
  LEFT JOIN customer_ongkir co ON co.cust_key = k.cust_key AND co.event = k.event
  LEFT JOIN payment_aggregates pa ON pa.event = k.event AND pa.cust_key = k.cust_key
  LEFT JOIN adjustment_aggregates adj ON adj.event = k.event AND adj.cust_key = k.cust_key
)
SELECT
  cust_key,
  -- Void invoice = nothing owed and nothing paid (matches paymentStatusFor);
  -- excluded from the count so it reads like the invoice page.
  COUNT(*) FILTER (WHERE NOT (invoice_total = 0 AND total_paid = 0)) AS invoice_count,
  COALESCE(SUM(invoice_total), 0)::bigint AS total_invoiced,
  COALESCE(SUM(invoice_total - total_paid), 0)::bigint AS total_outstanding
FROM per_invoice
GROUP BY cust_key;

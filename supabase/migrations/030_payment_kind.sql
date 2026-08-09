-- Pivot "apply an overpayment as credit to another order" from adjustments to
-- payments, and add a payment `kind` so internal credit transfers and cash
-- refunds are distinguishable from real deposits.
--
-- The adjustments.refund_id link (migration 028) was never used (0 rows) — the
-- adjustments-based version never ran in production — so drop it.
--
-- All payment kinds still count toward total_paid; `kind` is for display and
-- cash reconciliation only (so "real money in/out" reports can exclude
-- internal credit transfers).
--
-- Additive and re-runnable. Run as the owning role (postgres) in Supabase.

-- 1. Drop the unused adjustments.refund_id (its index + FK drop with the column).
ALTER TABLE adjustments DROP COLUMN IF EXISTS refund_id;

-- 2. payments.kind: 'deposit' (money in), 'refund' (cash out), 'credit'
--    (internal overpayment transfer between events).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'deposit'
  CHECK (kind IN ('deposit', 'refund', 'credit'));

-- 3. Link a payment to the refund that produced it (cash refund or credit
--    transfer), so a transfer can be undone precisely. ON DELETE SET NULL —
--    deleting a refund must not delete the money rows it produced.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_refund_id ON payments (refund_id);

-- 4. Backfill: existing cash-refund payments are the ones executeRefund linked
--    via refunds.payment_id. Tag them 'refund' and set the back-link. Amounts
--    are unchanged — a refund is money out, so it stays negative.
UPDATE payments p
   SET kind = 'refund', refund_id = r.id
  FROM refunds r
 WHERE r.payment_id = p.id;

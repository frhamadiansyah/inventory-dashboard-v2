-- Fix duplicate auto-detected overpayment refunds and prevent recurrence.
--
-- Cause: materializeOverpaymentRefunds() runs on every /refunds load and does a
-- check-then-insert (INSERT ... SELECT ... WHERE NOT EXISTS <active overpayment
-- refund>). Two overlapping requests both pass the NOT EXISTS before either
-- commits, so both insert the whole batch — producing pairs of identical pending
-- overpayment refunds (seen created milliseconds apart).
--
-- 1) Remove the duplicate ACTIVE overpayment refunds, keeping the earliest (MIN
--    id) per (event, normalized customer). Only delete rows with NO linked
--    payments — i.e. nothing was applied/refunded against them (safe; verified
--    0 such rows have payments). 2) Add a partial UNIQUE index so at most one
--    active overpayment refund can exist per (event, customer) — a hard,
--    concurrency-safe guarantee. The materializer also takes an advisory lock so
--    it never trips this in normal operation.
--
-- Run as owner in Supabase. Idempotent.

DELETE FROM refunds r
WHERE r.reason = 'overpayment'
  AND r.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id)
  AND r.id > (
    SELECT MIN(r2.id) FROM refunds r2
    WHERE r2.reason = 'overpayment'
      AND r2.status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
      AND r2.event = r.event
      AND lower(replace(r2.customer, '@', '')) = lower(replace(r.customer, '@', ''))
  );

CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_active_overpayment
  ON refunds (event, lower(replace(customer, '@', '')))
  WHERE reason = 'overpayment'
    AND status IN ('pending', 'awaiting_bank_info', 'ready_to_refund');

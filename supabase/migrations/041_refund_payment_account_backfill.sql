-- payments.account means "our bank the money moved through" (BCA/JAGO/...)
-- on every row, but executeRefund used to write the CUSTOMER's receiving
-- account number there instead. The code now records the sending account
-- picked at execute time; this backfills the rows created before the fix.
--
-- All past refund transfers were sent from Jago (confirmed by owner), so the
-- old customer-account-number values are replaced with 'JAGO'. The customer's
-- receiving bank details are not lost — they live on the refunds row
-- (bank_name / bank_account_number / bank_account_holder).

UPDATE payments
SET account = 'JAGO'
WHERE kind = 'refund'
  AND account NOT IN ('BCA', 'JAGO', 'QRIS', 'TRANSFER');

-- Links an adjustment back to the refund that created it, for the "apply an
-- overpayment as credit to another order" flow. Applying a credit posts a
-- negative adjustment on the target event (and, for an overpayment, a matching
-- positive one on the source); tagging both with the refund id lets the credit
-- be undone *precisely* — delete exactly these rows — if it was applied to the
-- wrong order. NULL for ordinary manual adjustments.
--
-- ON DELETE SET NULL: deleting a refund must not cascade-delete the money it
-- already moved; the adjustments simply lose the back-reference.
--
-- Additive and re-runnable.

ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_adjustments_refund_id ON adjustments (refund_id);

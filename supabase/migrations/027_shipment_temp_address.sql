-- One-time override of the receiving address for a shipment. When NULL the
-- label flow falls back to the customer's profile data_diri (the normal case).
-- When set, the value is what the label PDF, the WhatsApp confirmation message,
-- and any reprint flows render — so the temp address survives even if the
-- customer's permanent address is later updated.
--
-- For "Ship together" merged shipments the same value is written to every row
-- in the merge_group (one physical box, one address), mirroring how
-- tracking_number is propagated.
--
-- Additive and re-runnable.

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS temp_address TEXT;

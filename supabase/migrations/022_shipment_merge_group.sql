-- "Ship together": combine one customer's orders across several events into a
-- single physical package. One shipment row is still written per event (so each
-- event's invoice keeps its own resi + ship status), but the rows are linked and
-- share a single shipping_id so the package shows as one entry with one number.
--
-- Additive and re-runnable.

-- 1. Link the per-event rows of a merged shipment.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS merge_group TEXT;
CREATE INDEX IF NOT EXISTS idx_shipments_merge_group ON shipments (merge_group);

-- 2. A merged package shares ONE shipping_id across its per-event rows, so the
--    global UNIQUE(shipping_id) is replaced with UNIQUE(shipping_id, event):
--    different events may share an id (a merge), but an id is still unique within
--    an event.
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_shipping_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shipments_shipping_id_event_key'
  ) THEN
    ALTER TABLE shipments
      ADD CONSTRAINT shipments_shipping_id_event_key UNIQUE (shipping_id, event);
  END IF;
END $$;

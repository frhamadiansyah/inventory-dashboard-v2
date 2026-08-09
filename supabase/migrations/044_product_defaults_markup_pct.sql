-- Add a configurable markup-rate percentage to product defaults.
-- Pre-fills the Add Product form's markup and the live-rate markup box.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS markup_pct NUMERIC NOT NULL DEFAULT 5;

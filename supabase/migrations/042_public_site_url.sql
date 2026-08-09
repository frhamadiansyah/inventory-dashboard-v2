-- Adds business_profile.public_site_url — the order-status site URL the
-- invoice and shipment messages link to. Previously hardcoded as a literal
-- URL inside both message_templates rows; now a {publicSiteUrl} token backed
-- by this column (see lib/business-profile.ts, lib/message-templates.ts).
--
-- The 040_settings.sql audit trigger on business_profile already covers this
-- column (row-level trigger, no re-registration needed for a new column).

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS public_site_url TEXT NOT NULL DEFAULT 'https://yubisayu-invoice.netlify.app/';

-- Surgical swap: replace the literal URL with the new token wherever it still
-- appears verbatim in the invoice/shipment templates. Templates an owner has
-- already customized to remove or change that URL are left untouched — this
-- only touches rows that still contain the exact old substring.
UPDATE message_templates
SET body = REPLACE(body, 'https://yubisayu-invoice.netlify.app/', '{publicSiteUrl}'),
    updated_at = NOW()
WHERE key IN ('invoice', 'shipment')
  AND body LIKE '%https://yubisayu-invoice.netlify.app/%';

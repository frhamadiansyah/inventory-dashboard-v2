-- Adds business_profile.dp_percent — the global "% of invoice total that
-- must be paid before the default invoice message is sent" threshold. Below
-- threshold, getInvoiceForCustomer sends the new invoice_dp template instead
-- (see lib/db/invoice.ts, lib/message-templates.ts).
--
-- DEFAULT 0 means every event's paid-so-far (always >= 0) already meets a
-- 0% threshold, so this column ships inert: no existing invoice message
-- changes until the owner sets a real percentage in Settings.
--
-- The 040_settings.sql audit trigger on business_profile already covers new
-- columns on that table (row-level trigger), same as 042_public_site_url.sql.

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS dp_percent NUMERIC(6,2) NOT NULL DEFAULT 0;

-- Seed the invoice_dp template row (body must match
-- lib/message-templates.ts DEFAULT_TEMPLATES.invoice_dp verbatim — see the
-- 040_settings.sql header comment for why). ON CONFLICT DO NOTHING so an
-- owner who's already customized this template (impossible before this
-- migration runs, but keeps the statement idempotent/re-runnable) isn't
-- overwritten.
INSERT INTO message_templates (key, body) VALUES
('invoice_dp', $tpl$INVOICE - DOWN PAYMENT
{eventId} {handle}

Produk:
{produkLines}

Subtotal Barang: Rp {subtotalBarang}
Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}

Down Payment yang dibutuhkan: {dpPercent}% (Rp {dpAmount})
Kekurangan Down Payment: Rp {dpShortfall}

Rekening an {bankAccountHolder}:
{bankAccountLines}

Mohon lakukan pembayaran down payment agar pesanan diproses.

Cek rekapan mandiri {publicSiteUrl}$tpl$)
ON CONFLICT (key) DO NOTHING;

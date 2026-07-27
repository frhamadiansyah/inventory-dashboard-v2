import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, type TemplateKey } from "../message-templates"
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "../business-profile"
import { DEFAULT_PRODUCT_DEFAULTS, type ProductDefaults } from "../product-defaults"

// ─── Message templates ───────────────────────────────────────────────────────
//
// Owner-editable wording for the app's customer-facing messages. See
// lib/message-templates.ts for the token contract; see
// app/api/sheets/message-templates/route.ts for the auth guard.

export async function getMessageTemplates(): Promise<Record<TemplateKey, string>> {
  const rows = await sql`SELECT key, body FROM message_templates`
  const byKey = new Map(rows.map((r) => [r.key as string, r.body as string]))
  const result = { ...DEFAULT_TEMPLATES }
  for (const key of TEMPLATE_KEYS) {
    const body = byKey.get(key)
    if (body) result[key] = body
  }
  return result
}

export async function updateMessageTemplate(
  key: TemplateKey,
  body: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO message_templates (key, body, updated_at) VALUES (${key}, ${body}, NOW())
    ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()
  `
}

// ─── Business profile ────────────────────────────────────────────────────────
//
// Shared business identity fields (bank details, DP threshold today; owner
// name/store name/phone number stored for later use). Single row, id always
// 1. See lib/business-profile.ts and app/api/sheets/business-profile/route.ts.

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const [row] = await sql`
    SELECT bank_account_holder, bank_account_lines, owner_name, store_name, phone_number, public_site_url, dp_percent
    FROM business_profile WHERE id = 1
  `
  if (!row) return DEFAULT_BUSINESS_PROFILE
  return {
    bankAccountHolder: row.bank_account_holder as string,
    bankAccountLines: row.bank_account_lines as string,
    ownerName: row.owner_name as string,
    storeName: row.store_name as string,
    phoneNumber: row.phone_number as string,
    publicSiteUrl: row.public_site_url as string,
    dpPercent: Number(row.dp_percent),
  }
}

export async function updateBusinessProfile(data: BusinessProfile, db: DBExecutor = sql): Promise<void> {
  await db`
    INSERT INTO business_profile (id, bank_account_holder, bank_account_lines, owner_name, store_name, phone_number, public_site_url, dp_percent, updated_at)
    VALUES (1, ${data.bankAccountHolder}, ${data.bankAccountLines}, ${data.ownerName}, ${data.storeName}, ${data.phoneNumber}, ${data.publicSiteUrl}, ${data.dpPercent}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      bank_account_holder = EXCLUDED.bank_account_holder,
      bank_account_lines = EXCLUDED.bank_account_lines,
      owner_name = EXCLUDED.owner_name,
      store_name = EXCLUDED.store_name,
      phone_number = EXCLUDED.phone_number,
      public_site_url = EXCLUDED.public_site_url,
      dp_percent = EXCLUDED.dp_percent,
      updated_at = NOW()
  `
}

// ─── Product defaults ────────────────────────────────────────────────────────
//
// Pre-filled values for the Add Product form (overseas pricing). Single row,
// id always 1. See lib/product-defaults.ts and
// app/api/sheets/product-defaults/route.ts.

export async function getProductDefaults(): Promise<ProductDefaults> {
  const [row] = await sql`
    SELECT profit_pct, operational_fee, packing_fee, markup_pct, tier_kurs_round_to, flat_fee,
           flat_fee_pct, flat_fee_min, default_country_id
    FROM product_defaults WHERE id = 1
  `
  if (!row) return DEFAULT_PRODUCT_DEFAULTS
  return {
    profitPct: Number(row.profit_pct),
    operationalFee: Number(row.operational_fee),
    packingFee: Number(row.packing_fee),
    markupPct: Number(row.markup_pct),
    tierKursRoundTo: Number(row.tier_kurs_round_to) || 5000,
    // NOT `|| 10000`: 0 is a legal fee (price at cost), and `||` would silently
    // rewrite it to the default.
    flatFee: Number(row.flat_fee) || 0,
    // Same reasoning: 0 is legal, so no `||` default.
    flatFeePct: Number(row.flat_fee_pct) || 0,
    flatFeeMin: Number(row.flat_fee_min) || 0,
    // NOT `|| null`: null means "start on IDR", and 0 is not a country id anybody has, so the
    // two must stay distinguishable.
    defaultCountryId: row.default_country_id != null ? Number(row.default_country_id) : null,
  }
}

export async function updateProductDefaults(data: ProductDefaults, db: DBExecutor = sql): Promise<void> {
  await db`
    INSERT INTO product_defaults (id, profit_pct, operational_fee, packing_fee, markup_pct,
      tier_kurs_round_to, flat_fee, flat_fee_pct, flat_fee_min, default_country_id, updated_at)
    VALUES (1, ${data.profitPct}, ${data.operationalFee}, ${data.packingFee}, ${data.markupPct},
      ${data.tierKursRoundTo}, ${data.flatFee}, ${data.flatFeePct}, ${data.flatFeeMin},
      ${data.defaultCountryId}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      profit_pct = EXCLUDED.profit_pct,
      operational_fee = EXCLUDED.operational_fee,
      packing_fee = EXCLUDED.packing_fee,
      markup_pct = EXCLUDED.markup_pct,
      tier_kurs_round_to = EXCLUDED.tier_kurs_round_to,
      flat_fee = EXCLUDED.flat_fee,
      flat_fee_pct = EXCLUDED.flat_fee_pct,
      flat_fee_min = EXCLUDED.flat_fee_min,
      default_country_id = EXCLUDED.default_country_id,
      updated_at = NOW()
  `
}

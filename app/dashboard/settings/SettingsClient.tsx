"use client"

import { useEffect, useState } from "react"
import {
  TEMPLATE_KEYS,
  REQUIRED_TOKENS,
  OPTIONAL_TOKENS,
  DEFAULT_TEMPLATES,
  fillTemplate,
  findMissingTokens,
  type TemplateKey,
} from "@/lib/message-templates"
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "@/lib/business-profile"
import { DEFAULT_PRODUCT_DEFAULTS, type ProductDefaults } from "@/lib/product-defaults"
import { PRICING_METHODS, PRICING_METHOD_LABEL, toPricingMethod } from "@/lib/pricing"
import type { CountryRow } from "@/lib/db"
import KursTiersSection from "./KursTiersSection"
import TierFeeBracketsSection from "./TierFeeBracketsSection"

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  invoice: "Invoice message",
  invoice_dp: "Invoice message — DP reminder",
  shipment: "Shipment confirmation",
  refund_specific: "Refund message — items unavailable",
  refund_generic: "Refund message — generic",
}

// Sample data so the preview pane renders something readable while editing —
// values only, never sent anywhere.
const SAMPLE_VARS: Record<TemplateKey, Record<string, string>> = {
  invoice: {
    eventId: "EVT1",
    handle: "@customer",
    produkLines: "Lip Balm x 2 x Rp 150,000",
    subtotalBarang: "300,000",
    weightKg: "2",
    perKgRate: "50,000",
    biayaLainnyaBlock: "\nBiaya Lainnya: Rp 10,000",
    sisaPelunasan: "250,000",
    bankAccountHolder: "Business Owner",
    bankAccountLines: "Bank Example 123456789",
    publicSiteUrl: "https://example.com/",
  },
  invoice_dp: {
    eventId: "EVT1",
    handle: "@customer",
    produkLines: "Lip Balm x 2 x Rp 150,000",
    subtotalBarang: "300,000",
    weightKg: "2",
    perKgRate: "50,000",
    biayaLainnyaBlock: "\nBiaya Lainnya: Rp 10,000",
    dpPercent: "30",
    dpAmount: "90,000",
    dpShortfall: "40,000",
    sisaPelunasan: "300,000",
    bankAccountHolder: "Business Owner",
    bankAccountLines: "Bank Example 123456789",
    publicSiteUrl: "https://example.com/",
  },
  shipment: {
    event: "EVT1",
    handle: "@customer",
    dataDiri: "Jane Doe\n0812xxxxxxx\nJl. Contoh No. 1, Jakarta",
    items: "Lip Balm x 2",
    publicSiteUrl: "https://example.com/",
  },
  refund_specific: {
    customer: "@customer",
    event: "EVT1",
    itemsList: "- Lip Balm",
    refundAmount: "Rp 150,000",
  },
  refund_generic: {
    customer: "@customer",
    event: "EVT1",
    refundAmount: "Rp 150,000",
  },
}

const textareaCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white font-mono focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors min-h-[240px] resize-y"

type Tab = "business" | "product-defaults" | "messages"

const TABS: { key: Tab; label: string }[] = [
  { key: "business", label: "Profile" },
  { key: "product-defaults", label: "Pricing" },
  { key: "messages", label: "Templates" },
]

export default function SettingsClient() {
  const [templates, setTemplates] = useState<Record<TemplateKey, string> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("business")

  useEffect(() => {
    fetch("/api/sheets/message-templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { templates?: Record<TemplateKey, string>; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.templates) setTemplates(data.templates)
      })
      .catch(() => setLoadError("Failed to load templates"))
  }, [])

  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>
  if (!templates) return <p className="text-sm text-gray-500">Loading…</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === t.key
                ? "bg-brand text-white"
                : "text-gray-500 hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Every panel stays mounted (each fetches its own data once) — only
          hidden ones are visually hidden, so switching tabs never refetches. */}
      <div className={tab === "business" ? "" : "hidden"}>
        <BusinessProfileSection />
      </div>
      {/* Every card here is pricing config, so they share one tab. Product defaults holds
          what is common to more than one method; the rest are per method, in
          PRICING_METHODS order.

          ProductDefaultsSection renders THREE of them — Product defaults, Profit Margin and
          Markup Flat — because all of those fields live in one product_defaults row behind
          one Save. Splitting the component would mean three components racing to write the
          same record. */}
      <div className={`flex flex-col gap-6 ${tab === "product-defaults" ? "" : "hidden"}`}>
        <ProductDefaultsSection />
        <TierFeeBracketsSection />
        <KursTiersSection />
      </div>
      <div className={`flex flex-col gap-6 ${tab === "messages" ? "" : "hidden"}`}>
        {TEMPLATE_KEYS.map((key) => (
          <TemplateSection key={key} templateKey={key} initialBody={templates[key]} />
        ))}
      </div>
    </div>
  )
}

const fieldInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function BusinessProfileSection() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/sheets/business-profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { profile?: BusinessProfile; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.profile) setProfile(data.profile)
      })
      .catch(() => setLoadError("Failed to load business profile"))
  }, [])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  async function handleSave() {
    if (!profile) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setProfile(DEFAULT_BUSINESS_PROFILE)
  }

  function field(key: keyof BusinessProfile, value: string) {
    setProfile((p) => (p ? { ...p, [key]: value } : p))
  }

  function setProfileNumber(key: "dpPercent", value: string) {
    setProfile((p) => (p ? { ...p, [key]: Number(value) || 0 } : p))
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Business profile</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-gray-500 hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !profile}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!profile && !loadError && <p className="text-xs text-gray-500">Loading…</p>}

      {profile && (
        <div className="grid md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Bank account holder</span>
            <span className="text-[10px] text-gray-400">Used in the invoice message.</span>
            <input
              value={profile.bankAccountHolder}
              onChange={(e) => field("bankAccountHolder", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Bank accounts</span>
            <span className="text-[10px] text-gray-400">One "Bank Name 123456789" per line. Used in the invoice message.</span>
            <textarea
              value={profile.bankAccountLines}
              onChange={(e) => field("bankAccountLines", e.target.value)}
              className={`${fieldInputCls} font-mono min-h-[70px] resize-y`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Public site URL</span>
            <span className="text-[10px] text-gray-400">Used in the invoice and shipment messages.</span>
            <input
              value={profile.publicSiteUrl}
              onChange={(e) => field("publicSiteUrl", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Down Payment %</span>
            <span className="text-[10px] text-gray-400">
              Customers below this % of an event's total get the DP reminder message instead of the invoice message. 0 = feature off.
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={profile.dpPercent}
              onChange={(e) => setProfileNumber("dpPercent", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Owner name</span>
            <span className="text-[10px] text-gray-400">Not used in any message yet.</span>
            <input
              value={profile.ownerName}
              onChange={(e) => field("ownerName", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Store name</span>
            <span className="text-[10px] text-gray-400">Not used in any message yet.</span>
            <input
              value={profile.storeName}
              onChange={(e) => field("storeName", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Phone number</span>
            <span className="text-[10px] text-gray-400">Not used in any message yet.</span>
            <input
              value={profile.phoneNumber}
              onChange={(e) => field("phoneNumber", e.target.value)}
              className={fieldInputCls}
            />
          </label>
        </div>
      )}
    </div>
  )
}

function ProductDefaultsSection() {
  const [defaults, setDefaults] = useState<ProductDefaults | null>(null)
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Only for the Default country select's options. A failure here is not surfaced: the rest of
  // the card is still usable, and the select falls back to showing IDR plus whatever id is
  // already saved. /api/sheets/countries returns { rows }, not { countries }.
  useEffect(() => {
    fetch("/api/sheets/countries", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { rows?: CountryRow[] }) => setCountries(data.rows ?? []))
      .catch(() => setCountries([]))
  }, [])

  useEffect(() => {
    fetch("/api/sheets/product-defaults", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { defaults?: ProductDefaults; error?: string }) => {
        if (data.error) setLoadError(data.error)
        else if (data.defaults) setDefaults(data.defaults)
      })
      .catch(() => setLoadError("Failed to load product defaults"))
  }, [])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  async function handleSave() {
    if (!defaults) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/product-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaults),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setDefaults(DEFAULT_PRODUCT_DEFAULTS)
  }

  function field(key: keyof ProductDefaults, value: string) {
    setDefaults((d) => (d ? { ...d, [key]: Number(value) || 0 } : d))
  }

  // Separate from field(): that one coerces with `Number(value) || 0`, which cannot express the
  // null this column uses to mean "start the form on IDR".
  function setDefaultCountry(value: string) {
    setDefaults((d) => (d ? { ...d, defaultCountryId: value === "" ? null : Number(value) } : d))
  }

  // Also separate from field(): this one is a string union, not a number.
  function setDefaultPricingMethod(value: string) {
    setDefaults((d) => (d ? { ...d, defaultPricingMethod: toPricingMethod(value) } : d))
  }

  const saveButton = (
    <button
      type="button"
      onClick={handleSave}
      disabled={saving || !defaults}
      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
    >
      {saving ? "Saving…" : "Save"}
    </button>
  )

  return (
    <>
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Product defaults</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {/* Reset lives on this card only: it restores DEFAULT_PRODUCT_DEFAULTS, which is
              the whole record — including the three fields shown in the Markup Flat card
              below. A second copy there would read as "reset the flat fee settings" and
              quietly clear the rest. */}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-gray-500 hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          {saveButton}
        </div>
      </div>

      <p className="text-[10px] text-gray-400">Pre-filled into the Add Product form. Editing this doesn't change any existing product.</p>

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!defaults && !loadError && <p className="text-xs text-gray-500">Loading…</p>}

      {defaults && (
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Operational fee</span>
            <input
              type="number"
              value={defaults.operationalFee}
              onChange={(e) => field("operationalFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Packing fee</span>
            <input
              type="number"
              value={defaults.packingFee}
              onChange={(e) => field("packingFee", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Markup rate %</span>
            <input
              type="number"
              value={defaults.markupPct}
              onChange={(e) => field("markupPct", e.target.value)}
              className={fieldInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Default pricing</span>
            <select
              value={defaults.defaultPricingMethod}
              onChange={(e) => setDefaultPricingMethod(e.target.value)}
              className={fieldInputCls}
            >
              {PRICING_METHODS.map((m) => (
                <option key={m} value={m}>{PRICING_METHOD_LABEL[m]}</option>
              ))}
            </select>
            <span className="text-[10px] text-gray-400">
              Which tab the Add Product form opens on. Profit Margin and both Rate methods
              need a country, so pair one of those with a Default country below or the form
              opens with that field empty.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Default country</span>
            <select
              value={defaults.defaultCountryId != null ? String(defaults.defaultCountryId) : ""}
              onChange={(e) => setDefaultCountry(e.target.value)}
              className={fieldInputCls}
            >
              {/* Empty value = NULL = no country, which the Add Product form shows as
                  "IDR (Rupiah)". A real option, not a placeholder. */}
              <option value="">IDR (Rupiah)</option>
              {countries.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
              ))}
            </select>
            <span className="text-[10px] text-gray-400">
              Which country the Add Product form starts on. For Markup and Flat Fee this also
              decides whether that form opens with a typed base cost (IDR) or one derived from
              valas.
            </span>
          </label>
        </div>
      )}
    </div>

    {/* Profit Margin's one setting. Ahead of Markup Flat because the per-method cards run in
        PRICING_METHODS order, and `overseas` is first.

        Unlike the Markup Flat figures below, this one IS a pre-fill: every Profit Margin
        product stores its own profit_pct, and the server prices from the row's copy, so
        changing this moves nothing that already exists. */}
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Profit Margin</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {saveButton}
        </div>
      </div>

      <p className="text-[10px] text-gray-400">
        Price is cost ÷ (1 − Profit %), plus the operational and packing fees, rounded up to
        the step below.
      </p>

      {defaults && (
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Profit %</span>
            <input
              type="number"
              value={defaults.profitPct}
              onChange={(e) => field("profitPct", e.target.value)}
              className={fieldInputCls}
            />
            <span className="text-[10px] text-gray-400">
              What the Add Product form starts on. Each product keeps its own copy, so
              editing this changes nothing that already exists. 100 or more leaves nothing to
              divide into, and the price computes as 0.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Rounding</span>
            <input
              type="number"
              min="1"
              step="1"
              value={defaults.profitMarginRoundTo}
              onChange={(e) => field("profitMarginRoundTo", e.target.value)}
              className={fieldInputCls}
            />
            {/* Unlike Profit % beside it, this is not a pre-fill — every Profit Margin
                product is rounded by whatever this holds when it is saved. */}
            <span className="text-[10px] text-gray-400">
              Prices round UP to this step. Separate from the Rate card&apos;s step, and read
              on a product&apos;s next save — so changing it reprices each one then, not now.
            </span>
          </label>
        </div>
      )}
    </div>

    {/* The three figures behind Markup's Flat toggle. Their own card because they are not
        form pre-fills like the rest of Product defaults: the SERVER re-reads all three
        inside the write transaction, so they are the authority over what a Flat Fee product
        is priced at — the same distinction Tier Kurs rounding carries, one card up.

        Same `defaults` state and the same PATCH, so this Save writes the whole record and
        the two cards can never disagree. No reset here — see the comment on the one above. */}
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Markup Flat</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {saveButton}
        </div>
      </div>

      <p className="text-[10px] text-gray-400">
        What a Flat Fee product earns — the Flat side of Markup&apos;s Tier | Flat toggle.
        Read when a product is saved, so every Flat Fee product uses the same figures.
      </p>

      {defaults && (
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Flat Fee</span>
            <input
              type="number"
              min="0"
              value={defaults.flatFee}
              onChange={(e) => field("flatFee", e.target.value)}
              className={fieldInputCls}
            />
            <span className="text-[10px] text-gray-400">
              Every Flat Fee product is priced base cost + this. Applies on a
              product&apos;s next save.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Flat Fee %</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={defaults.flatFeePct}
              onChange={(e) => field("flatFeePct", e.target.value)}
              className={fieldInputCls}
            />
            <span className="text-[10px] text-gray-400">
              Used instead of the amount above by Flat Fee products with Percent switched
              on. Applies on a product&apos;s next save.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Flat Fee minimum</span>
            <input
              type="number"
              min="0"
              value={defaults.flatFeeMin}
              onChange={(e) => field("flatFeeMin", e.target.value)}
              className={fieldInputCls}
            />
            <span className="text-[10px] text-gray-400">
              Floor under the percentage above, for when a small base would earn less than
              the work costs. 0 = no floor. Percent mode only.
            </span>
          </label>
        </div>
      )}
    </div>
    </>
  )
}

function TemplateSection({ templateKey, initialBody }: { templateKey: TemplateKey; initialBody: string }) {
  const [body, setBody] = useState(initialBody)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const missing = findMissingTokens(body, templateKey)
  const preview = fillTemplate(body, SAMPLE_VARS[templateKey])

  async function handleSave() {
    if (missing.length > 0) {
      setError(`Missing required token(s): ${missing.join(", ")}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/message-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: templateKey, body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setBody(DEFAULT_TEMPLATES[templateKey])
    setError(null)
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">{TEMPLATE_LABELS[templateKey]}</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleReset}
            title="Reset to default"
            aria-label="Reset to default"
            className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg border border-cream-border text-gray-500 hover:border-brand hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Required tokens:{" "}
        {REQUIRED_TOKENS[templateKey].map((t) => (
          <code
            key={t}
            className={`mx-0.5 px-1 py-0.5 rounded ${missing.includes(t) ? "bg-red-100 text-red-600" : "bg-cream text-gray-600"}`}
          >
            {t}
          </code>
        ))}
        {OPTIONAL_TOKENS[templateKey].length > 0 && (
          <>
            {" "}· Optional:{" "}
            {OPTIONAL_TOKENS[templateKey].map((t) => (
              <code
                key={t}
                title={body.includes(t) ? undefined : "Not in the template — its content will be left out of the message"}
                className={`mx-0.5 px-1 py-0.5 rounded ${body.includes(t) ? "bg-cream text-gray-400" : "bg-amber-100 text-amber-700"}`}
              >
                {t}
              </code>
            ))}
          </>
        )}
      </p>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="grid md:grid-cols-2 gap-3">
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); setError(null) }}
          className={textareaCls}
          spellCheck={false}
        />
        <div className="border border-cream-border rounded-lg px-3 py-2 bg-cream/40 overflow-auto">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Preview</p>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground">{preview}</pre>
        </div>
      </div>
    </div>
  )
}

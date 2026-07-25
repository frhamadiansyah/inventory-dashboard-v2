"use client"

// Editor for the Tier Kurs brackets: per country, from which valas upward to
// charge which exchange rate.
//
// This lives beside the pricing-template editor rather than inside it, because a
// bracket set is per-COUNTRY data while a template's tier step is per-TEMPLATE
// config. Three things here that the template editor's TierEditor has no way to
// show: the country's actual rate to compare against, the resulting markup
// percentage, and a try-a-valas readout that runs the real resolver.

import { useEffect, useMemo, useState } from "react"
import SearchableSelect from "@/components/SearchableSelect"
import { useKursTiers } from "@/hooks/useKursTiers"
import { resolveTieredKurs, tiersForCountry } from "@/lib/kurs-tiers"
import { calcTierKursPrice, tierKursProfit } from "@/lib/pricing"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import type { CountryRow } from "@/lib/db"

const inputCls =
  "border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const btnCls =
  "px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
const iconBtnCls =
  "w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md border border-cream-border text-gray-400 hover:border-brand hover:text-brand disabled:opacity-30 transition-colors"

const fmt = (n: number) => n.toLocaleString("id-ID")

/** Bracket being edited. Strings, as the number inputs produce. */
type BandDraft = { minValas: string; kurs: string }

export default function KursTiersSection() {
  const { tiers, loading, error, reload } = useKursTiers()
  const productDefaults = useProductDefaults()
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [countryId, setCountryId] = useState<number | null>(null)
  const [draft, setDraft] = useState<BandDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tryValas, setTryValas] = useState("500")

  // /api/sheets/countries returns { rows }, not { countries }.
  useEffect(() => {
    fetch("/api/sheets/countries", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        const rows = (j.rows ?? []) as CountryRow[]
        setCountries(rows)
        setCountryId((prev) => prev ?? rows[0]?.id ?? null)
      })
      .catch(() => {})
  }, [])

  const country = countries.find((c) => c.id === countryId)
  const stored = useMemo(() => tiersForCountry(tiers, countryId), [tiers, countryId])

  // Reset the draft from what's stored, but never over unsaved edits.
  useEffect(() => {
    if (dirty) return
    setDraft(stored.map((t) => ({ minValas: String(t.minValas), kurs: String(t.kurs) })))
  }, [stored, dirty])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const setBand = (i: number, patch: Partial<BandDraft>) => {
    setDraft((d) => d.map((b, j) => (j === i ? { ...b, ...patch } : b)))
    setDirty(true)
  }

  const problems = useMemo(() => {
    const out: string[] = []
    const seen = new Set<number>()
    draft.forEach((b, i) => {
      const where = `Bracket ${i + 1}`
      const min = Number(b.minValas)
      const kurs = Number(b.kurs)
      if (b.minValas.trim() === "" || !Number.isFinite(min) || min < 0) {
        out.push(`${where}: "from" must be 0 or more`)
      } else if (seen.has(min)) {
        out.push(`${where}: another bracket already starts at ${min}`)
      } else {
        seen.add(min)
      }
      if (b.kurs.trim() === "" || !Number.isFinite(kurs) || kurs <= 0) {
        out.push(`${where}: rate must be above 0`)
      }
    })
    return out
  }, [draft])

  // The real resolver AND the real formula, over the draft — so the readout
  // previews unsaved edits and includes the configured rounding step.
  const previewValas = Number(tryValas) || 0
  const charged = resolveTieredKurs(
    draft.map((b) => ({ minValas: b.minValas, kurs: b.kurs })),
    previewValas,
    country?.kurs ?? 0,
  )
  const roundTo = productDefaults?.tierKursRoundTo ?? 5000
  const preview = calcTierKursPrice({
    valas: previewValas,
    tieredKurs: charged,
    kurs: country?.kurs ?? 0,
    roundTo,
  })

  const changeCountry = (next: number | null) => {
    if (dirty && !confirm("Discard unsaved bracket changes?")) return
    setDirty(false)
    setSaveError(null)
    setCountryId(next)
  }

  const handleSave = async () => {
    if (countryId == null || problems.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/kurs-tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countryId,
          bands: draft.map((b) => ({ minValas: Number(b.minValas), kurs: Number(b.kurs) })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to save")
      await reload()
      setDirty(false)
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Tier Kurs brackets</h2>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || countryId == null || problems.length > 0}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Products priced with the <span className="font-medium">Tier Kurs</span> method are
        charged the rate for the bracket their valas falls into, instead of the
        country&apos;s flat rate. Highest matching minimum wins, and minimums are
        inclusive — so a &ldquo;1001 and up&rdquo; bracket starts at 1001.
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Country</span>
          <SearchableSelect
            value={countryId != null ? String(countryId) : ""}
            onChange={(v) => changeCountry(v ? Number(v) : null)}
            options={countries.map((c) => ({ value: String(c.id), label: `${c.name} (${c.currency})` }))}
            placeholder="Select country…"
            searchable={false}
            alwaysShowAll
          />
        </label>
        {country && (
          <span className="text-xs text-gray-500 pb-2">
            Actual rate <span className="font-semibold text-foreground">{fmt(country.kurs)}</span>
          </span>
        )}
      </div>

      {countryId != null && (
        <>
          <div className="flex flex-col gap-1.5">
            {draft.length === 0 && (
              <p className="text-xs text-gray-400">
                No brackets. Tier Kurs products for this country are priced at the flat
                rate, with no margin.
              </p>
            )}
            {draft.map((band, i) => {
              const kurs = Number(band.kurs)
              const markup =
                country && country.kurs > 0 && Number.isFinite(kurs) && kurs > 0
                  ? (kurs / country.kurs - 1) * 100
                  : null
              return (
                <div key={i} className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-gray-400 shrink-0 w-20">from valas</span>
                  <input
                    value={band.minValas}
                    onChange={(e) => setBand(i, { minValas: e.target.value })}
                    type="number" min="0" step="any"
                    className={`${inputCls} w-32 shrink-0`}
                  />
                  <span className="text-xs text-gray-400 shrink-0">charge</span>
                  <input
                    value={band.kurs}
                    onChange={(e) => setBand(i, { kurs: e.target.value })}
                    type="number" min="0" step="any"
                    className={`${inputCls} w-32 shrink-0`}
                  />
                  {markup != null && (
                    <span
                      className={`text-xs shrink-0 tabular-nums ${markup >= 0 ? "text-green-700" : "text-red-600"}`}
                    >
                      {markup >= 0 ? "+" : ""}{markup.toFixed(1)}%
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((d) => d.filter((_, j) => j !== i))
                      setDirty(true)
                    }}
                    className={iconBtnCls}
                    aria-label="Remove bracket"
                  >×</button>
                </div>
              )
            })}
            <button
              type="button"
              onClick={() => {
                setDraft((d) => [...d, { minValas: "0", kurs: String(country?.kurs ?? 0) }])
                setDirty(true)
              }}
              className={`${btnCls} self-start`}
            >
              + Bracket
            </button>
          </div>

          {problems.length > 0 && (
            <ul className="text-xs text-red-500 flex flex-col gap-0.5">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {saveError && <p className="text-xs text-red-500">{saveError}</p>}

          {/* Runs the same resolver the server runs, over the draft, so a bracket
              set can be checked before any product uses it. */}
          <div className="rounded-lg bg-gray-50 border border-cream-border px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-500">Try a valas</span>
              <input
                value={tryValas}
                onChange={(e) => setTryValas(e.target.value)}
                type="number" min="0" step="any"
                className={`${inputCls} w-28 shrink-0`}
              />
            </div>
            <p className="text-xs text-gray-500 tabular-nums">
              charged <span className="font-semibold text-foreground">{fmt(charged)}</span>
              {" → price "}
              <span className="font-semibold text-foreground">Rp {fmt(Math.round(preview.price))}</span>
              {" · cost Rp "}{fmt(Math.round(preview.cogs))}
              {" · profit "}
              <span className={preview.price - preview.cogs >= 0 ? "text-green-700" : "text-red-600"}>
                Rp {fmt(tierKursProfit(preview))}
              </span>
            </p>
            <p className="text-[10px] text-gray-400">
              Rounded up to {fmt(roundTo)}, set under Settings → Pricing.
            </p>
          </div>

          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Brackets are read when a product is saved. Changing them doesn&apos;t reprice
            existing products — each one reprices the next time it is saved.
          </p>
        </>
      )}
    </div>
  )
}

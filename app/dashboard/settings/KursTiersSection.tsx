"use client"

// Editor for the Tier Kurs brackets: per country, from which valas upward to
// charge which exchange rate.
//
// Its own card under Settings → Pricing, below Product defaults: a bracket set is
// per-COUNTRY data with a cross-row invariant and its own Save, so it can't fold
// into that card's flat field grid — but it belongs in the same tab, and it reads
// the rounding step configured there.
//
// Every country is listed as an expandable row rather than reached through a
// picker: there are only a handful, and the collapsed header answers "which
// countries have tiered pricing at all, and how wide is the spread" without any
// clicking. Each row keeps its own draft and its own Save, because the API writes
// one country's whole set at a time.

import { useEffect, useMemo, useRef, useState } from "react"
import { useKursTiers } from "@/hooks/useKursTiers"
import { resolveTieredKurs, tiersForCountry } from "@/lib/kurs-tiers"
import { calcTierKursPrice, tierKursProfit } from "@/lib/pricing"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import type { CountryRow, KursTierRow } from "@/lib/db"

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
  const [open, setOpen] = useState<Set<number>>(new Set())
  const autoOpened = useRef(false)

  // /api/sheets/countries returns { rows }, not { countries }.
  useEffect(() => {
    fetch("/api/sheets/countries", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setCountries((j.rows ?? []) as CountryRow[]))
      .catch(() => {})
  }, [])

  // Expand the already-configured countries once, on first load — that is what
  // the owner came here to look at. Guarded by a ref so a post-save reload never
  // re-opens a row the owner collapsed.
  useEffect(() => {
    if (autoOpened.current || loading || tiers.length === 0) return
    autoOpened.current = true
    setOpen(new Set(tiers.map((t) => t.countryId)))
  }, [tiers, loading])

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const roundTo = productDefaults?.tierKursRoundTo ?? 5000

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Tier Kurs brackets</h2>

      <p className="text-xs text-gray-500">
        Products priced with the <span className="font-medium">Tier Kurs</span>{" "}
        method are charged the rate for the bracket their valas falls into, instead of the
        country&apos;s flat rate. Highest matching minimum wins, and minimums are
        inclusive — so a &ldquo;1001 and up&rdquo; bracket starts at 1001.
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-2">
        {countries.map((country) => (
          <CountryBrackets
            key={country.id}
            country={country}
            stored={tiersForCountry(tiers, country.id)}
            roundTo={roundTo}
            open={open.has(country.id)}
            onToggle={() => toggle(country.id)}
            onSaved={reload}
          />
        ))}
        {countries.length === 0 && !loading && (
          <p className="text-xs text-gray-400">No countries yet.</p>
        )}
      </div>

      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Brackets are read when a product is saved. Changing them doesn&apos;t reprice
        existing products — each one reprices the next time it is saved.
      </p>
    </div>
  )
}

/**
 * One country's bracket set: collapsed summary plus the editor.
 *
 * The body stays mounted while collapsed so unsaved edits survive a collapse —
 * which is also what makes the header's "unsaved" marker meaningful.
 */
function CountryBrackets({
  country,
  stored,
  roundTo,
  open,
  onToggle,
  onSaved,
}: {
  country: CountryRow
  stored: KursTierRow[]
  roundTo: number
  open: boolean
  onToggle: () => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<BandDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tryValas, setTryValas] = useState("500")

  // Reset the draft from what's stored, but never over unsaved edits.
  //
  // Fires on the CONTENTS of `stored`, not the array identity: tiersForCountry
  // returns a fresh array every render, so depending on it directly would re-seed
  // the draft on every render and each setDraft would trigger the next one. The
  // ref is how the effect still reads the current rows without listing them.
  const storedKey = stored.map((t) => `${t.minValas}:${t.kurs}`).join("|")
  const latestStored = useRef(stored)
  latestStored.current = stored
  useEffect(() => {
    if (dirty) return
    setDraft(
      latestStored.current.map((t) => ({ minValas: String(t.minValas), kurs: String(t.kurs) })),
    )
  }, [storedKey, dirty])

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
    country.kurs,
  )
  const preview = calcTierKursPrice({
    valas: previewValas,
    tieredKurs: charged,
    kurs: country.kurs,
    // No product here, so no weight: this previews what the BRACKETS do to a valas
    // amount. A real product's cost also carries (gram / 1000) × the country's
    // shipping rate, so its profit will be lower than what this shows.
    gram: 0,
    cargoPerKg: 0,
    // Nor a packing charge: this previews what the BRACKETS do, not a whole product.
    packingFee: 0,
    roundTo,
  })

  // Off the draft, not `stored`: while clean they are equal, and while dirty the
  // header should describe what the open editor shows.
  const rates = draft.map((b) => Number(b.kurs)).filter((n) => Number.isFinite(n) && n > 0)
  const spread =
    rates.length > 0
      ? rates.length > 1 && Math.min(...rates) !== Math.max(...rates)
        ? `${fmt(Math.min(...rates))}–${fmt(Math.max(...rates))}`
        : fmt(rates[0])
      : null

  const handleSave = async () => {
    if (problems.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/kurs-tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countryId: country.id,
          bands: draft.map((b) => ({ minValas: Number(b.minValas), kurs: Number(b.kurs) })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to save")
      await onSaved()
      setDirty(false)
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-cream-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-cream/40 transition-colors"
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-sm font-medium text-foreground shrink-0">
          {country.name} ({country.currency})
        </span>
        <span className="text-xs text-gray-400 shrink-0 tabular-nums">
          actual {fmt(country.kurs)}
        </span>
        <span className="flex-1" />
        {dirty && <span className="text-xs text-amber-700 shrink-0">unsaved</span>}
        {saved && <span className="text-xs text-green-600 shrink-0">Saved</span>}
        <span className={`text-xs shrink-0 tabular-nums ${draft.length > 0 ? "text-gray-500" : "text-gray-400"}`}>
          {draft.length === 0
            ? "no brackets"
            : `${draft.length} bracket${draft.length > 1 ? "s" : ""}${spread ? ` · ${spread}` : ""}`}
        </span>
      </button>

      <div className={`px-3 pb-3 flex flex-col gap-2 ${open ? "" : "hidden"}`}>
        <div className="flex flex-col gap-1.5">
          {draft.length === 0 && (
            <p className="text-xs text-gray-400">
              No brackets. Tier Kurs products for {country.name} are priced at the flat
              rate of {fmt(country.kurs)}, with no margin.
            </p>
          )}
          {draft.map((band, i) => {
            const kurs = Number(band.kurs)
            const markup =
              country.kurs > 0 && Number.isFinite(kurs) && kurs > 0
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
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setDraft((d) => [...d, { minValas: "0", kurs: String(country.kurs) }])
              setDirty(true)
            }}
            className={btnCls}
          >
            + Bracket
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty || problems.length > 0}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
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
              Rp {fmt(tierKursProfit({ ...preview, packingFee: 0 }))}
            </span>
          </p>
          <p className="text-[10px] text-gray-400">
            Rounded up to {fmt(roundTo)}, set under Product defaults above.
          </p>
        </div>
      </div>
    </div>
  )
}

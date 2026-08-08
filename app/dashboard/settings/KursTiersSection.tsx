"use client"

// Everything that decides what a Rate product is charged: the rounding step both methods
// round up to, then per country its flat rate and its brackets.
//
// Its own card under Settings → Pricing, below Product defaults, because none of this is a
// form pre-fill — the server reads all of it inside the write transaction, so it sets what a
// product's price IS rather than what its form opens with. The bracket sets also carry a
// cross-row invariant and save a whole country at a time, which no flat field grid can hold.
//
// THREE separate Saves in one card, which is unusual enough to say why: the rounding step is
// a product_defaults column, and each country's rate configuration is its own atomic write.
// Different records, so one button could not honestly report what it had saved.
//
// Every country is listed as an expandable row rather than reached through a picker: there
// are only a handful, and the collapsed header answers "which countries are configured, and
// how" without any clicking.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKursTiers } from "@/hooks/useKursTiers"
import { resolveTieredKurs, tiersForCountry } from "@/lib/kurs-tiers"
import { calcKursPrice, kursProfit } from "@/lib/pricing"
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
  //
  // Hoisted out of the effect because a save has to re-run it: the flat rate lives on the
  // COUNTRY, so `reload` from useKursTiers — which refetches brackets only — would leave
  // country.flatKurs at its page-load value, and the panel's re-seed effect would then snap
  // the field back to the pre-save number the moment Save cleared `dirty`.
  const loadCountries = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/countries", { cache: "no-store" })
      const json = await res.json()
      setCountries((json.rows ?? []) as CountryRow[])
    } catch {
      // Leave the previous list in place; the panel keeps working off what it has.
    }
  }, [])

  useEffect(() => { loadCountries() }, [loadCountries])

  // Both halves of one Save, so both have to be refetched before the panel re-seeds.
  const reloadAll = useCallback(async () => {
    await Promise.all([reload(), loadCountries()])
  }, [reload, loadCountries])

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

  // Countries the owner revealed this session with the Add control below. They are not yet
  // configured — that is the whole point — so nothing in the data would keep them on screen,
  // and a country would vanish mid-edit the moment its draft was cleared. Cleared on reload,
  // by which time a saved country is configured and listed on its own merit.
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [toAdd, setToAdd] = useState("")

  // A country belongs on the list once it has something to show: brackets, a flat rate, or
  // the owner having just asked for it. Listing every country made this card as long as the
  // Currencies page and buried the two or three that are actually configured.
  const isConfigured = (c: CountryRow) =>
    Number(c.flatKurs) > 0 || tiersForCountry(tiers, c.id).length > 0

  const visible = countries.filter((c) => isConfigured(c) || revealed.has(c.id))
  const addable = countries.filter((c) => !isConfigured(c) && !revealed.has(c.id))

  function addCountry() {
    const id = Number(toAdd)
    if (!id) return
    setRevealed((prev) => new Set(prev).add(id))
    // Opened straight away: the owner picked it in order to configure it, and landing on a
    // collapsed row would need a second click to do the thing they just asked for.
    setOpen((prev) => new Set(prev).add(id))
    setToAdd("")
  }

  // The rounding step lives in product_defaults, not in the bracket tables — it is one
  // number shared by both Rate methods, so it belongs to neither country and to neither
  // member. It is edited HERE rather than among the Add Product pre-fills because it is not
  // a pre-fill: the server reads it inside the write transaction, so it decides what a
  // product's price actually is.
  //
  // Its own draft and its own Save, because it is a different RECORD from the brackets
  // beside it. The draft also feeds every panel's preview below, so a typed step is
  // reflected before it is saved.
  const [roundDraft, setRoundDraft] = useState<string | null>(null)
  const [roundSaving, setRoundSaving] = useState(false)
  const [roundSaved, setRoundSaved] = useState(false)
  const [roundError, setRoundError] = useState<string | null>(null)

  // Seeded once the fetch lands, and never over a value being typed — null is "not seeded
  // yet", which is why this is not simply initialised from productDefaults.
  useEffect(() => {
    if (roundDraft == null && productDefaults) setRoundDraft(String(productDefaults.tierKursRoundTo))
  }, [productDefaults, roundDraft])

  useEffect(() => {
    if (!roundSaved) return
    const t = setTimeout(() => setRoundSaved(false), 2000)
    return () => clearTimeout(t)
  }, [roundSaved])

  const roundParsed = Number(roundDraft)
  const roundValid = Number.isInteger(roundParsed) && roundParsed >= 1
  const roundTo = roundValid ? roundParsed : (productDefaults?.tierKursRoundTo ?? 5000)
  const roundDirty = productDefaults != null && roundDraft != null
    && roundParsed !== productDefaults.tierKursRoundTo

  // The endpoint validates every field of the record, so the whole object goes back with
  // one figure changed — a partial body would be rejected, not merged.
  async function saveRounding() {
    if (!productDefaults || !roundValid) return
    setRoundSaving(true)
    setRoundError(null)
    try {
      const res = await fetch("/api/sheets/product-defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...productDefaults, tierKursRoundTo: roundParsed }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to save")
      setRoundSaved(true)
    } catch (err) {
      setRoundError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setRoundSaving(false)
    }
  }

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Rate</h2>

      <p className="text-xs text-gray-500">
        Both <span className="font-medium">Rate</span> methods charge an exchange rate above
        what the goods cost. <span className="font-medium">Flat Rate</span> products are
        charged the country&apos;s one flat rate whatever the valas;{" "}
        <span className="font-medium">Tier Rate</span> products are charged the rate for the
        bracket their valas falls into. A country can serve both — set either, or both.
        Highest matching minimum wins, and minimums are inclusive, so a &ldquo;1001 and
        up&rdquo; bracket starts at 1001. A country with no flat rate charges Flat Rate
        products at cost.
      </p>

      {/* Card-level, above the per-country list, because it is the one figure here that is
          not per country. */}
      <div className="flex flex-col gap-1 pb-3 border-b border-cream-border">
        <label className="text-xs text-gray-500" htmlFor="rate-rounding">Rounding</label>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            id="rate-rounding"
            value={roundDraft ?? ""}
            onChange={(e) => setRoundDraft(e.target.value)}
            type="number" min="1" step="1" placeholder="5000"
            disabled={roundSaving || productDefaults == null}
            className={`${inputCls} w-32 shrink-0 tabular-nums`}
          />
          <button
            type="button"
            onClick={saveRounding}
            disabled={roundSaving || !roundValid || !roundDirty}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-light transition-colors disabled:opacity-50"
          >
            {roundSaving ? "Saving…" : "Save"}
          </button>
          {roundSaved && <span className="text-xs text-green-600">Saved</span>}
          {roundDirty && !roundSaved && <span className="text-xs text-amber-700">unsaved</span>}
        </div>
        {!roundValid && roundDraft != null && (
          <p className="text-xs text-red-500">Rounding must be a whole number of at least 1.</p>
        )}
        {roundError && <p className="text-xs text-red-500">{roundError}</p>}
        <span className="text-[10px] text-gray-400">
          Prices for both Rate methods round UP to this step. Shared with nothing else, and
          read when a product is saved — so changing it reprices each product on its next
          save, not now.
        </span>
      </div>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-2">
        {visible.map((country) => (
          <CountryBrackets
            key={country.id}
            country={country}
            stored={tiersForCountry(tiers, country.id)}
            roundTo={roundTo}
            open={open.has(country.id)}
            onToggle={() => toggle(country.id)}
            onSaved={reloadAll}
          />
        ))}
        {countries.length === 0 && !loading && (
          <p className="text-xs text-gray-400">No countries yet.</p>
        )}
        {countries.length > 0 && visible.length === 0 && !loading && (
          <p className="text-xs text-gray-400">
            No country has a rate configured. Add one below to start.
          </p>
        )}
      </div>

      {/* Only the unconfigured countries, so the picker shrinks as the list above grows and
          the same country can never be added twice. Hidden entirely once every country is
          configured, when it could only offer an empty menu. */}
      {addable.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={toAdd}
            onChange={(e) => setToAdd(e.target.value)}
            aria-label="Country to configure"
            className={`${inputCls} w-56`}
          >
            <option value="">Add a country…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
            ))}
          </select>
          <button type="button" onClick={addCountry} disabled={!toAdd} className={btnCls}>
            Add
          </button>
        </div>
      )}

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
  // The flat rate lives beside the brackets rather than in its own card: it is the
  // alternative to them, one Save covers both, and the API writes both in one transaction.
  const [flatDraft, setFlatDraft] = useState(String(country.flatKurs))
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
  // country.flatKurs joins storedKey in the dependencies: a save reloads the countries list,
  // and without it the field would keep showing the pre-save value.
  useEffect(() => {
    if (dirty) return
    setDraft(
      latestStored.current.map((t) => ({ minValas: String(t.minValas), kurs: String(t.kurs) })),
    )
    setFlatDraft(String(country.flatKurs))
  }, [storedKey, dirty, country.flatKurs])

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
    // Empty is not 0 — an owner who clears the field means "no flat rate", which IS 0. But a
    // negative or unparseable one is a typo, and saving it would price at cost with no sign
    // that anything was wrong.
    const flat = flatDraft.trim() === "" ? 0 : Number(flatDraft)
    if (!Number.isFinite(flat) || flat < 0) out.push("Flat rate must be 0 or more")
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
  }, [draft, flatDraft])

  // The real resolver AND the real formula, over the draft — so the readout
  // previews unsaved edits and includes the configured rounding step.
  const previewValas = Number(tryValas) || 0
  const charged = resolveTieredKurs(
    draft.map((b) => ({ minValas: b.minValas, kurs: b.kurs })),
    previewValas,
    country.kurs,
  )
  const preview = calcKursPrice({
    valas: previewValas,
    chargedKurs: charged,
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
          flatKurs: flatDraft.trim() === "" ? 0 : Number(flatDraft),
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
        {/* The header answers "which countries are configured, and how" without expanding,
            so the flat rate belongs beside the bracket summary rather than behind a click. */}
        <span className={`text-xs shrink-0 tabular-nums ${draft.length > 0 || Number(flatDraft) > 0 ? "text-gray-500" : "text-gray-400"}`}>
          {[
            Number(flatDraft) > 0 ? `flat ${fmt(Number(flatDraft))}` : null,
            draft.length === 0
              ? null
              : `${draft.length} bracket${draft.length > 1 ? "s" : ""}${spread ? ` · ${spread}` : ""}`,
          ].filter(Boolean).join(" · ") || "not configured"}
        </span>
      </button>

      <div className={`px-3 pb-3 flex flex-col gap-2 ${open ? "" : "hidden"}`}>
        {/* Above the brackets and ruled off from them: it is the alternative to them, not
            one of them, and the two methods it serves are picked by a toggle on the product
            rather than by anything here. */}
        <div className="flex flex-col gap-1 pb-3 mb-1 border-b border-cream-border">
          <label className="text-xs text-gray-500">Flat rate (IDR)</label>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={flatDraft}
              onChange={(e) => { setFlatDraft(e.target.value); setDirty(true) }}
              type="number" min="0" step="any" placeholder="0"
              disabled={saving}
              className={`${inputCls} w-32 shrink-0 tabular-nums`}
            />
            <span className="text-xs text-gray-400">
              {Number(flatDraft) > 0
                ? `charged to Flat Rate products · costs ${fmt(country.kurs)}`
                : `not set — Flat Rate products are charged ${fmt(country.kurs)}, the cost rate, for no margin`}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          {draft.length === 0 && (
            <p className="text-xs text-gray-400">
              No brackets. Tier Rate products for {country.name} are charged{" "}
              {fmt(country.kurs)}, the cost rate, with no margin.
            </p>
          )}
          {draft.map((band, i) => {
            const kurs = Number(band.kurs)
            const markup =
              country.kurs > 0 && Number.isFinite(kurs) && kurs > 0
                ? (kurs / country.kurs - 1) * 100
                : null
            return (
              // No flex-wrap: a bracket is one row at every width. On a phone the two word
              // labels move into the inputs as placeholders and the inputs share whatever is
              // left, because "from valas 5000 charge 226" wrapped into a ragged three-line
              // block that read as three separate controls rather than one bracket.
              <div key={i} className="flex items-center gap-1.5">
                <span className="hidden md:inline text-xs text-gray-400 shrink-0 w-20">from valas</span>
                <input
                  value={band.minValas}
                  onChange={(e) => setBand(i, { minValas: e.target.value })}
                  type="number" min="0" step="any"
                  placeholder="from valas"
                  className={`${inputCls} flex-1 min-w-0 md:flex-none md:w-32 md:shrink-0`}
                />
                <span className="hidden md:inline text-xs text-gray-400 shrink-0">charge</span>
                <input
                  value={band.kurs}
                  onChange={(e) => setBand(i, { kurs: e.target.value })}
                  type="number" min="0" step="any"
                  placeholder="charge"
                  className={`${inputCls} flex-1 min-w-0 md:flex-none md:w-32 md:shrink-0`}
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
              Rp {fmt(kursProfit({ ...preview, packingFee: 0 }))}
            </span>
          </p>
          <p className="text-[10px] text-gray-400">
            Rounded up to {fmt(roundTo)}, the step set at the top of this card.
          </p>
        </div>
      </div>
    </div>
  )
}

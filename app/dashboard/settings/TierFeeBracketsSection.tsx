"use client"

// Editor for the Tier Fee brackets: from which base amount upward to charge which
// fee.
//
// One expandable row per scope — Rupiah first, then every country — because a Tier
// Fee product is priced in rupiah when it has no country and in that country's
// currency when it has one, and each of those needs its own bracket set. Same shape
// as KursTiersSection, and for the same reason: the collapsed header answers "which
// scopes are configured" without any clicking, and each scope keeps its own draft and
// Save because the API writes one scope at a time.
//
// The two scopes differ in more than their numbers, which the panels say out loud:
// the Rupiah set only pre-fills a form field, while a country's set is resolved
// server-side on every save and therefore reprices.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTierFeeBrackets } from "@/hooks/useTierFeeBrackets"
import {
  DEFAULT_RUPIAH_TIER_FEE_BRACKETS,
  bracketsForScope,
  resolveTierFee,
  toTierFeeMode,
  type TierFeeMode,
} from "@/lib/tier-fee"
import { calcTierFeeValasPrice, calcRupiahFeePrice, ceilTo } from "@/lib/pricing"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import type { CountryRow, TierFeeBracketRow } from "@/lib/db"

const inputCls =
  "border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const btnCls =
  "px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
const iconBtnCls =
  "w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md border border-cream-border text-gray-400 hover:border-brand hover:text-brand disabled:opacity-30 transition-colors"

const fmt = (n: number) => n.toLocaleString("id-ID")
const fmt2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString("id-ID")

/** Bracket being edited. Strings, as the number inputs produce. */
type BracketDraft = { minBase: string; feeMode: TierFeeMode; feeValue: string }

const toDraft = (b: { minBase: number; feeMode: TierFeeMode; feeValue: number }): BracketDraft => ({
  minBase: String(b.minBase),
  feeMode: b.feeMode,
  feeValue: String(b.feeValue),
})

export default function TierFeeBracketsSection() {
  const { brackets, loading, error, reload } = useTierFeeBrackets()
  const productDefaults = useProductDefaults()
  const [countries, setCountries] = useState<CountryRow[]>([])
  // null is a real key here — the rupiah scope — so this is a Set of `number | null`,
  // not a Set of number with a sentinel.
  const [open, setOpen] = useState<Set<number | null>>(new Set([null]))

  // /api/sheets/countries returns { rows }, not { countries }.
  useEffect(() => {
    fetch("/api/sheets/countries", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setCountries((j.rows ?? []) as CountryRow[]))
      .catch(() => {})
  }, [])

  const toggle = (key: number | null) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const roundTo = productDefaults?.tierKursRoundTo ?? 5000

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Tier Fee brackets</h2>

      <p className="text-xs text-gray-500">
        A <span className="font-medium">Tier Fee</span> product is priced base + fee,
        where the fee comes from the bracket its base amount falls into. Highest
        matching minimum wins, and minimums are inclusive. A product with no country is
        priced in rupiah; one with a country is priced in that country&apos;s currency
        and converted at its rate.
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-2">
        <ScopeBrackets
          country={null}
          stored={bracketsForScope(brackets, null)}
          roundTo={roundTo}
          open={open.has(null)}
          onToggle={() => toggle(null)}
          onSaved={reload}
        />
        {countries.map((country) => (
          <ScopeBrackets
            key={country.id}
            country={country}
            stored={bracketsForScope(brackets, country.id)}
            roundTo={roundTo}
            open={open.has(country.id)}
            onToggle={() => toggle(country.id)}
            onSaved={reload}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One scope's bracket set: collapsed summary plus the editor.
 *
 * The body stays mounted while collapsed so unsaved edits survive a collapse — which
 * is also what makes the header's "unsaved" marker meaningful.
 */
function ScopeBrackets({
  country,
  stored,
  roundTo,
  open,
  onToggle,
  onSaved,
}: {
  /** null = the rupiah scope. */
  country: CountryRow | null
  stored: TierFeeBracketRow[]
  roundTo: number
  open: boolean
  onToggle: () => void
  onSaved: () => Promise<void>
}) {
  const isValas = country != null
  const unit = isValas ? country.currency : "Rp"

  const [draft, setDraft] = useState<BracketDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tryBase, setTryBase] = useState(isValas ? "500" : "500000")

  // Reset the draft from what's stored, but never over unsaved edits. Fires on the
  // CONTENTS of `stored`, not the array identity: bracketsForScope returns a fresh
  // array every render, so depending on it directly would re-seed the draft on every
  // render and each setDraft would trigger the next.
  const storedKey = stored.map((b) => `${b.minBase}:${b.feeMode}:${b.feeValue}`).join("|")
  const latestStored = useRef(stored)
  latestStored.current = stored
  useEffect(() => {
    if (dirty) return
    setDraft(latestStored.current.map(toDraft))
  }, [storedKey, dirty])

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(t)
  }, [saved])

  const setBracket = (i: number, patch: Partial<BracketDraft>) => {
    setDraft((d) => d.map((b, j) => (j === i ? { ...b, ...patch } : b)))
    setDirty(true)
  }

  const problems = useMemo(() => {
    const out: string[] = []
    const seen = new Set<number>()
    draft.forEach((b, i) => {
      const where = `Bracket ${i + 1}`
      const min = Number(b.minBase)
      const value = Number(b.feeValue)
      // A valas floor may legitimately be fractional; a rupiah one may not.
      const badMin =
        b.minBase.trim() === "" || !Number.isFinite(min) || min < 0 ||
        (!isValas && !Number.isInteger(min))
      if (badMin) {
        out.push(`${where}: "from" must be ${isValas ? "0 or more" : "a whole number, 0 or more"}`)
      } else if (seen.has(min)) {
        out.push(`${where}: another bracket already starts at ${min}`)
      } else {
        seen.add(min)
      }
      if (b.feeValue.trim() === "" || !Number.isFinite(value) || value < 0) {
        out.push(`${where}: fee must be 0 or more`)
      }
    })
    return out
  }, [draft, isValas])

  // The real resolver and the real formula over the draft, so the readout previews
  // unsaved edits and includes the configured rounding step.
  const previewBase = Number(tryBase) || 0
  const fee = resolveTierFee(draft, previewBase)
  const rawValas = isValas ? (previewBase + fee) * country.kurs : 0
  const preview = isValas
    ? calcTierFeeValasPrice({ valas: previewBase, feeValas: fee, kurs: country.kurs, roundTo })
    : { cogs: previewBase, price: calcRupiahFeePrice(previewBase, Math.round(fee)) }

  const summary =
    draft.length === 0 ? "no brackets" : `${draft.length} bracket${draft.length > 1 ? "s" : ""}`

  const handleSave = async () => {
    if (problems.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/tier-fee-brackets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countryId: country?.id ?? null,
          brackets: draft.map((b) => ({
            minBase: Number(b.minBase),
            feeMode: toTierFeeMode(b.feeMode),
            feeValue: Number(b.feeValue),
          })),
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
          {isValas ? `${country.name} (${country.currency})` : "Rupiah — no country"}
        </span>
        {isValas && (
          <span className="text-xs text-gray-400 shrink-0 tabular-nums">
            rate {fmt(country.kurs)}
          </span>
        )}
        <span className="flex-1" />
        {dirty && <span className="text-xs text-amber-700 shrink-0">unsaved</span>}
        {saved && <span className="text-xs text-green-600 shrink-0">Saved</span>}
        <span className={`text-xs shrink-0 ${draft.length > 0 ? "text-gray-500" : "text-gray-400"}`}>
          {summary}
        </span>
      </button>

      <div className={`px-3 pb-3 flex flex-col gap-2 ${open ? "" : "hidden"}`}>
        <p className="text-[11px] text-gray-400">
          {isValas ? (
            <>
              Base and fee are both in {country.currency}. The fee is added to the base
              first, then the total is converted at {country.name}&apos;s rate of{" "}
              {fmt(country.kurs)} and rounded up to {fmt(roundTo)}.
            </>
          ) : (
            <>Base and fee are both in rupiah, and the price is exactly base + fee.</>
          )}
        </p>

        <div className="flex flex-col gap-1.5">
          {draft.length === 0 && (
            <p className="text-xs text-gray-400">
              {isValas
                ? `No brackets. Tier Fee products for ${country.name} are priced at cost, with no fee.`
                : "No brackets. The Fee field is left at 0 and typed in by hand."}
            </p>
          )}
          {draft.map((bracket, i) => {
            const min = Number(bracket.minBase)
            const value = Number(bracket.feeValue)
            // What a percent bracket charges at its own floor — the one base where it
            // is directly comparable to a fixed one.
            const atFloor =
              bracket.feeMode === "percent" && Number.isFinite(min) && Number.isFinite(value)
                ? (min * value) / 100
                : null
            return (
              <div key={i} className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-gray-400 shrink-0 w-12">from</span>
                <input
                  value={bracket.minBase}
                  onChange={(e) => setBracket(i, { minBase: e.target.value })}
                  type="number" min="0" step={isValas ? "any" : "1"}
                  className={`${inputCls} w-28 shrink-0`}
                />
                <span className="text-xs text-gray-400 shrink-0">fee</span>
                <select
                  value={bracket.feeMode}
                  onChange={(e) => setBracket(i, { feeMode: toTierFeeMode(e.target.value) })}
                  className={`${inputCls} w-28 shrink-0`}
                >
                  <option value="fixed">{unit}</option>
                  <option value="percent">% of base</option>
                </select>
                <input
                  value={bracket.feeValue}
                  onChange={(e) => setBracket(i, { feeValue: e.target.value })}
                  type="number" min="0" step="any"
                  className={`${inputCls} w-28 shrink-0`}
                />
                {atFloor != null && (
                  <span className="text-xs text-gray-400 shrink-0 tabular-nums">
                    = {unit} {fmt2(atFloor)} at {fmt(min)}
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
              setDraft((d) => [...d, { minBase: "0", feeMode: "fixed", feeValue: "0" }])
              setDirty(true)
            }}
            className={btnCls}
          >
            + Bracket
          </button>
          {/* Only the rupiah scope has a "default": it is the table that used to be
              hardcoded in the products page. There is no such history for a country. */}
          {!isValas && (
            <button
              type="button"
              onClick={() => {
                setDraft(DEFAULT_RUPIAH_TIER_FEE_BRACKETS.map(toDraft))
                setDirty(true)
              }}
              className={btnCls}
            >
              Reset to default
            </button>
          )}
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

        {/* Runs the same resolver and formula the server runs, over the draft, so a
            bracket set can be checked before any product uses it. */}
        <div className="rounded-lg bg-gray-50 border border-cream-border px-3 py-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500">
              Try a base {isValas ? `(${country.currency})` : "cost"}
            </span>
            <input
              value={tryBase}
              onChange={(e) => setTryBase(e.target.value)}
              type="number" min="0" step="any"
              className={`${inputCls} w-32 shrink-0`}
            />
          </div>
          {isValas ? (
            <>
              <p className="text-xs text-gray-500 tabular-nums">
                fee <span className="font-semibold text-foreground">{unit} {fmt2(fee)}</span>
                {` → (${fmt(previewBase)} + ${fmt2(fee)}) × ${fmt(country.kurs)} = Rp ${fmt(Math.round(rawValas))}`}
              </p>
              <p className="text-xs text-gray-500 tabular-nums">
                rounded up to {fmt(roundTo)} → price{" "}
                <span className="font-semibold text-foreground">Rp {fmt(Math.round(preview.price))}</span>
                {" · cost Rp "}{fmt(Math.round(preview.cogs))}
                {" · profit "}
                <span className={preview.price - preview.cogs >= 0 ? "text-green-700" : "text-red-600"}>
                  Rp {fmt(Math.round(preview.price - preview.cogs))}
                </span>
              </p>
              {ceilTo(rawValas, roundTo) !== rawValas && (
                <p className="text-[10px] text-gray-400 tabular-nums">
                  The rounding added Rp {fmt(Math.round(preview.price - rawValas))} on top of the fee.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500 tabular-nums">
              fee <span className="font-semibold text-foreground">Rp {fmt(Math.round(fee))}</span>
              {" → price "}
              <span className="font-semibold text-foreground">Rp {fmt(Math.round(preview.price))}</span>
            </p>
          )}
        </div>

        <p className={`text-xs rounded-lg px-3 py-2 border ${
          isValas
            ? "text-amber-700 bg-amber-50 border-amber-200"
            : "text-gray-500 bg-gray-50 border-cream-border"
        }`}>
          {isValas ? (
            <>
              These are read when a product is saved and the price is computed from them
              on the server. Changing them doesn&apos;t reprice existing products — each
              one reprices the next time it is saved.
            </>
          ) : (
            <>
              A starting point, not a rule: the Fee field stays editable, and changing
              these brackets never reprices an existing product — not even when it is
              next saved.
            </>
          )}
        </p>
      </div>
    </div>
  )
}

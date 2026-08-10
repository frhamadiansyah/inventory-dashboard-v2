"use client"

// Editor for the Tier Fee brackets: from which base amount upward to charge which
// fee.
//
// One expandable row per scope — Rupiah, then Valas. Both sets are rupiah (migrations
// 056/057); the difference is which base cost they are matched against, and the Valas
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
import type { TierFeeScope } from "@/lib/tier-fee"
import {
  DEFAULT_RUPIAH_TIER_FEE_BRACKETS,
  RUPIAH_TIER_FEE_ROUND_TO,
  bracketsForScope,
  resolveTierFee,
  pickTierFeeBracket,
  toTierFeeMode,
  type TierFeeMode,
} from "@/lib/tier-fee"
import { calcTierFeeValasPrice, ceilTo } from "@/lib/pricing"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import MoneyInput from "@/components/MoneyInput"
import type { CountryRow, TierFeeBracketRow } from "@/lib/db"

const inputCls =
  "border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const btnCls =
  "px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"

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
  // Two scopes, not one per country (migrations 056/057), so a plain Set of the scope names.
  // Both start closed.
  const [open, setOpen] = useState<Set<TierFeeScope>>(new Set<TierFeeScope>())

  const toggle = (key: TierFeeScope) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const roundTo = productDefaults?.tierKursRoundTo ?? 5000

  return (
    <div className="bg-white border border-cream-border rounded-xl p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Markup Tier</h2>

      <p className="text-xs text-gray-500">
        A <span className="font-medium">Markup Tier</span> product is priced base cost + fee,
        where the fee comes from the bracket its base cost falls into. Highest matching
        minimum wins, and minimums are inclusive.{" "}
        <span className="font-medium">Both sets are in rupiah.</span> Rupiah is matched
        against the base cost you type; Valas is matched against the base cost derived from
        valas × rate + freight, and is shared by every country.
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:items-start md:gap-3">
        {(["rupiah", "valas"] as const).map((scope) => (
          <ScopeBrackets
            key={scope}
            scope={scope}
            stored={bracketsForScope(brackets, scope)}
            roundTo={roundTo}
            open={open.has(scope)}
            onToggle={() => toggle(scope)}
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
  scope,
  stored,
  roundTo,
  open,
  onToggle,
  onSaved,
}: {
  scope: TierFeeScope
  stored: TierFeeBracketRow[]
  roundTo: number
  open: boolean
  onToggle: () => void
  onSaved: () => Promise<void>
}) {
  const isValas = scope === "valas"
  // Both scopes are rupiah now, so there is no per-scope unit.
  const unit = "Rp"

  const [draft, setDraft] = useState<BracketDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tryBase, setTryBase] = useState(isValas ? "500" : "807246")

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
  // Both scopes are base cost + fee, and both round the total — valas to the
  // configurable roundTo, rupiah to the fixed RUPIAH_TIER_FEE_ROUND_TO (Flat Fee, which
  // shares the same "cost + fee" shape, stays exact — see that constant's doc). Fed as a
  // bare rupiah base — this previews what the BRACKETS do, so there is no rate or weight
  // to convert through, and a real product's base cost also carries freight.
  const rawTotal = previewBase + Math.round(fee)
  const preview = {
    cogs: previewBase,
    price: isValas ? ceilTo(rawTotal, roundTo) : ceilTo(rawTotal, RUPIAH_TIER_FEE_ROUND_TO),
  }

  // Which bracket produced `fee`, so the preview can spell out the arithmetic instead of
  // just the result — a percent bracket's "15% of X" isn't obvious from the fee alone.
  const matchedBracket = pickTierFeeBracket(draft, previewBase)
  const feeExplain =
    matchedBracket == null
      ? "No bracket matches this base — fee is 0."
      : matchedBracket.feeMode === "percent"
        ? `${fmt2(Number(matchedBracket.feeValue))}% of ${unit} ${fmt(previewBase)} = ${unit} ${fmt2(fee)}`
        : `Flat fee: ${unit} ${fmt2(Number(matchedBracket.feeValue))}`

  const summary =
    draft.length === 0 ? "NO BRACKETS" : `${draft.length} BRACKET${draft.length > 1 ? "S" : ""}`

  const handleSave = async () => {
    if (problems.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/tier-fee-brackets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
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
          {isValas ? "VALAS" : "RUPIAH"}
        </span>
        {isValas && (
          <span className="text-xs text-gray-400 shrink-0 tabular-nums">
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
              Matched against the base cost derived from valas × rate + freight, so the
              floors are rupiah like the set above. Shared by every country. The fee is added
              to that base cost and the total rounded up to {fmt(roundTo)}.
            </>
          ) : (
            <>
              Base and fee are both in rupiah, and the price is base + fee rounded up to
              {" "}{fmt(RUPIAH_TIER_FEE_ROUND_TO)}. The Fee field stays editable, and
              changing these brackets never reprices an existing product — not even when
              it is next saved.
            </>
          )}
        </p>

        {/* overflow-x-auto: side-by-side on desktop (the wrapper in the parent) halves this
            panel's width, and a bracket row's fixed-width fields (see below) don't shrink
            past their md:w-28, so a narrower desktop viewport scrolls a row instead of
            clipping or wrapping it. */}
        <div className="flex flex-col gap-1.5 overflow-x-auto">
          {draft.length === 0 && (
            <p className="text-xs text-gray-400">
              {isValas
                ? "No brackets. Markup Tier products with a country are priced at cost, with no fee."
                : "No brackets. The Fee field is left at 0 and typed in by hand."}
            </p>
          )}
          {draft.map((bracket, i) => {
            return (
              // No flex-wrap: a bracket is one row at every width. On a phone the two word
              // labels move into the controls, which is fine now that the worked example
              // (once shown per-row) lives in "Try a base cost" below instead.
              <div key={i} className="flex items-center gap-1.5">
                <span className="hidden md:inline text-xs text-gray-400 shrink-0">From</span>
                <MoneyInput
                  value={bracket.minBase}
                  onChange={(v) => setBracket(i, { minBase: v })}
                  placeholder="from"
                  name={`bracket-${scope}-${i}-from`}
                  wrapClassName="flex-1 min-w-0 md:flex-none md:w-28 md:shrink-0"
                />
                <span className="hidden md:inline text-xs text-gray-400 shrink-0 ml-2">Fee</span>
                {/* Fixed, not flex-1 like From/Fee beside it: on mobile, splitting the row
                    three ways evenly left From too narrow to read its own value once it
                    grew a "Rp" prefix. text-sm (not text-xs) so its py-1.5 matches the
                    MoneyInput's own py-1.5 + text-sm exactly, same height as the boxes
                    beside it. */}
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-sm font-medium shrink-0 w-16 md:w-28">
                  <button
                    type="button"
                    onClick={() => setBracket(i, { feeMode: "fixed" })}
                    aria-pressed={bracket.feeMode === "fixed"}
                    className={`flex-1 py-1.5 transition-colors ${bracket.feeMode === "fixed" ? "bg-brand text-white" : "text-gray-500 hover:bg-cream"}`}
                  >
                    {unit}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBracket(i, { feeMode: "percent" })}
                    aria-pressed={bracket.feeMode === "percent"}
                    className={`flex-1 py-1.5 transition-colors ${bracket.feeMode === "percent" ? "bg-brand text-white" : "text-gray-500 hover:bg-cream"}`}
                  >
                    %
                  </button>
                </div>
                <MoneyInput
                  value={bracket.feeValue}
                  onChange={(v) => setBracket(i, { feeValue: v })}
                  placeholder="fee"
                  unit={bracket.feeMode === "fixed" ? "Rp" : "%"}
                  name={`bracket-${scope}-${i}-fee`}
                  wrapClassName="flex-1 min-w-0 md:flex-none md:w-28 md:shrink-0"
                />
                {/* Mobile: bare light-grey trash icon, no frame — the bordered × box read
                    as one more input in an already-tight row. Already flush right: From
                    and Fee beside it are both flex-1, so they claim all the row's free
                    space before this shrink-0 button gets any. Desktop keeps the bordered
                    × box. */}
                <button
                  type="button"
                  onClick={() => {
                    setDraft((d) => d.filter((_, j) => j !== i))
                    setDirty(true)
                  }}
                  className="shrink-0 inline-flex items-center justify-center w-8 h-[34px] text-gray-300 hover:text-gray-400 transition-colors md:w-7 md:h-7 md:text-gray-400 md:border md:border-cream-border md:rounded-md md:hover:border-brand md:hover:text-brand disabled:opacity-30"
                  aria-label="Remove bracket"
                >
                  <svg className="md:hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
                  </svg>
                  <span className="hidden md:inline">×</span>
                </button>
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
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              // Same default table for both scopes — the one that used to be hardcoded
              // in the products page.
              setDraft(DEFAULT_RUPIAH_TIER_FEE_BRACKETS.map(toDraft))
              setDirty(true)
            }}
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
              Try a base cost
            </span>
            <MoneyInput
              value={tryBase}
              onChange={setTryBase}
              wrapClassName="w-32 shrink-0"
            />
          </div>
          {isValas ? (
            <>
              <p className="text-xs text-gray-400 tabular-nums">{feeExplain}</p>
              <p className="text-xs text-gray-500 tabular-nums">
                fee <span className="font-semibold text-foreground">{unit} {fmt2(fee)}</span>
                {` → Rp ${fmt(previewBase)} + Rp ${fmt2(fee)}, rounded up to ${fmt(roundTo)}`}
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
              {preview.price !== rawTotal && (
                <p className="text-[10px] text-gray-400 tabular-nums">
                  The rounding added Rp {fmt(Math.round(preview.price - rawTotal))} on top of the fee.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-gray-400 tabular-nums">{feeExplain}</p>
              <p className="text-xs text-gray-500 tabular-nums">
                fee <span className="font-semibold text-foreground">Rp {fmt2(fee)}</span>
                {` → Rp ${fmt(previewBase)} + Rp ${fmt2(fee)}, rounded up to ${fmt(RUPIAH_TIER_FEE_ROUND_TO)}`}
              </p>
              <p className="text-xs text-gray-500 tabular-nums">
                rounded up to {fmt(RUPIAH_TIER_FEE_ROUND_TO)} → price{" "}
                <span className="font-semibold text-foreground">Rp {fmt(Math.round(preview.price))}</span>
                {" · cost Rp "}{fmt(Math.round(preview.cogs))}
                {" · profit "}
                <span className={preview.price - preview.cogs >= 0 ? "text-green-700" : "text-red-600"}>
                  Rp {fmt(Math.round(preview.price - preview.cogs))}
                </span>
              </p>
              {preview.price !== rawTotal && (
                <p className="text-[10px] text-gray-400 tabular-nums">
                  The rounding added Rp {fmt(Math.round(preview.price - rawTotal))} on top of the fee.
                </p>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  )
}

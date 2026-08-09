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

// Draft values stay plain dot-decimal numeric strings (Number(draft.minBase) etc. depend
// on that everywhere else in this file) — these two only convert at the input's edge, for
// a live id-ID thousand-separator display ("." groups, "," is the decimal point). A valas
// floor may be fractional, so the split is on the decimal point, not just digits.
function formatMoney(raw: string): string {
  if (raw === "") return ""
  const [intPart, decPart] = raw.split(".")
  const digits = intPart.replace(/\D/g, "")
  const grouped = digits === "" ? "" : Number(digits).toLocaleString("id-ID")
  return decPart !== undefined ? `${grouped},${decPart}` : grouped
}

function parseMoney(formatted: string): string {
  const commaIdx = formatted.indexOf(",")
  if (commaIdx === -1) return formatted.replace(/\D/g, "")
  const intDigits = formatted.slice(0, commaIdx).replace(/\D/g, "")
  const decDigits = formatted.slice(commaIdx + 1).replace(/\D/g, "")
  return `${intDigits}.${decDigits}`
}

/** A bracket's "from"/fee amount: unit label ("Rp" ahead of the number, "%" after it, like
 *  the values they annotate are normally written), live thousand-separator formatting. */
function MoneyInput({
  value,
  onChange,
  placeholder,
  wrapClassName,
  unit = "Rp",
}: {
  value: string
  onChange: (raw: string) => void
  placeholder?: string
  wrapClassName?: string
  unit?: "Rp" | "%"
}) {
  const isSuffix = unit === "%"
  return (
    <div className={`relative ${wrapClassName ?? ""}`}>
      <span
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs text-gray-400 ${isSuffix ? "right-2" : "left-2"}`}
      >
        {unit}
      </span>
      <input
        value={formatMoney(value)}
        onChange={(e) => onChange(parseMoney(e.target.value))}
        inputMode="decimal"
        placeholder={placeholder}
        className={`${inputCls} w-full ${isSuffix ? "pr-6" : "pl-7"}`}
      />
    </div>
  )
}

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
  const [open, setOpen] = useState<Set<TierFeeScope>>(new Set<TierFeeScope>(["rupiah"]))

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

      <div className="flex flex-col gap-2">
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
  // Both scopes are base cost + fee; only the valas scope rounds the total. Fed as a bare
  // rupiah base — this previews what the BRACKETS do, so there is no rate or weight to
  // convert through, and a real product's base cost also carries freight.
  const rawTotal = previewBase + Math.round(fee)
  const preview = {
    cogs: previewBase,
    price: isValas ? ceilTo(rawTotal, roundTo) : calcRupiahFeePrice(previewBase, Math.round(fee)),
  }

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
          {isValas ? "Valas — every country" : "Rupiah — no country"}
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
            <>Base and fee are both in rupiah, and the price is exactly base + fee.</>
          )}
        </p>

        <div className="flex flex-col gap-1.5">
          {draft.length === 0 && (
            <p className="text-xs text-gray-400">
              {isValas
                ? "No brackets. Markup Tier products with a country are priced at cost, with no fee."
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
              // No flex-wrap: a bracket is one row at every width. On a phone the two word
              // labels move into the controls and the worked example drops, because three
              // fixed-width controls plus a sentence wrapped into a ragged block that read as
              // several separate settings rather than one bracket. The example is derived —
              // it restates what this bracket charges at its own floor — so it is the one
              // thing here that can go without losing a setting.
              <div key={i} className="flex items-center gap-1.5">
                <span className="hidden md:inline text-xs text-gray-400 shrink-0 w-12">From</span>
                <MoneyInput
                  value={bracket.minBase}
                  onChange={(v) => setBracket(i, { minBase: v })}
                  placeholder="from"
                  wrapClassName="flex-1 min-w-0 md:flex-none md:w-28 md:shrink-0"
                />
                <span className="hidden md:inline text-xs text-gray-400 shrink-0 ml-2">Fee</span>
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs font-medium flex-1 min-w-0 md:flex-none md:w-28 md:shrink-0">
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
                  wrapClassName="flex-1 min-w-0 md:flex-none md:w-28 md:shrink-0"
                />
                {atFloor != null && (
                  <span className="hidden md:inline text-xs text-gray-400 shrink-0 tabular-nums">
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
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              // Rupiah has a real default — the table that used to be hardcoded in the
              // products page. Valas never had one; its "default" is the empty set,
              // same as a fresh install (Markup Tier products with a country price at
              // cost, no fee, until the owner adds brackets).
              setDraft(isValas ? [] : DEFAULT_RUPIAH_TIER_FEE_BRACKETS.map(toDraft))
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

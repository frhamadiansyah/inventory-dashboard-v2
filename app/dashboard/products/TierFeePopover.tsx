"use client"

// Shows which Markup Tier bracket a base cost lands in, and what the other brackets would
// charge — so the fee isn't a number with no explanation.
//
// Serves both scopes, which since migrations 056/057 are one concept in ONE unit: both sets
// are rupiah, and both are matched against a rupiah base cost. What differs is only where
// that base cost comes from and what happens after the fee is added:
//
//   rupiah scope — base is the typed cost, `entered` is the typed fee, and the panel calls
//                  out an override, since the field is only ever pre-filled.
//   valas scope  — base is the DERIVED cost (valas × rate + freight) and `rounding` is
//                  supplied, so the panel shows the total being rounded up to the price.
//                  Nothing is overridable there: the server resolves it.
//
// Panel chrome and positioning come from InfoPopover.

import InfoPopover from "@/components/InfoPopover"
import { pickTierFeeBracket, tierFeeAmount, toTierFeeMode } from "@/lib/tier-fee"
import { ceilTo } from "@/lib/pricing"
import type { TierFeeBracketRow } from "@/lib/db"

const fmt = (n: number) => n.toLocaleString("id-ID")
const fmt2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString("id-ID")

export default function TierFeePopover({
  base,
  brackets,
  unit,
  entered,
  rounding,
  disabled,
}: {
  /** The base amount to resolve: a rupiah cost, or a valas amount. */
  base: number
  /** Already scoped to the right country (or the rupiah set). null while loading. */
  brackets: TierFeeBracketRow[] | null
  /** "Rp", or the country's currency code. */
  unit: string
  /** Rupiah mode only: what is currently in the Fee field, so an override shows. */
  entered?: number
  /** Valas scope only: the step the fee-plus-cost total is rounded up to. Absent means the
   *  total is exact, which is what the rupiah scope does. */
  rounding?: number
  disabled?: boolean
}) {
  const active = pickTierFeeBracket(brackets ?? [], base)
  const fee = tierFeeAmount(active, base)
  const sorted = [...(brackets ?? [])].sort((a, b) => a.minBase - b.minBase)
  const overridden = entered != null && Math.round(entered) !== Math.round(fee)

  const raw = base + fee
  const price = rounding ? ceilTo(raw, rounding) : raw

  return (
    <InfoPopover
      ariaLabel="Show Tier Fee brackets"
      disabled={disabled}
      width={rounding ? 320 : 300}
    >
      <p className="text-xs font-semibold text-foreground">
        Markup Tier brackets — {rounding ? "valas" : "rupiah"}
      </p>

      {brackets == null ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className={`text-xs ${rounding ? "text-amber-700" : "text-gray-500"}`}>
          {rounding
            ? "No brackets, so the fee is 0 and this product is priced at cost."
            : "No brackets set, so nothing is suggested."}
          {" Add them under Settings → Pricing."}
        </p>
      ) : (
        <div className="flex flex-col">
          {sorted.map((b) => {
            const isActive = active != null && b.id === active.id
            return (
              <div
                key={b.id}
                className={`flex items-center justify-between gap-2 px-2 py-1 rounded-md text-xs tabular-nums ${
                  isActive ? "bg-brand/10 text-foreground font-medium" : "text-gray-500"
                }`}
              >
                <span>from {fmt2(b.minBase)}</span>
                <span>
                  {toTierFeeMode(b.feeMode) === "percent"
                    ? // At the CURRENT base, so a percent row is comparable to a fixed
                      // one — but only for the row that actually applies; for the
                      // others that figure would be hypothetical.
                      `${b.feeValue}%${isActive ? ` = ${unit} ${fmt2(fee)}` : ""}`
                    : `${unit} ${fmt2(b.feeValue)}`}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="border-t border-cream-border pt-2 flex flex-col gap-1">
        {rounding ? (
          <>
            <p className="text-xs text-gray-500 tabular-nums">
              Base cost <span className="font-semibold text-foreground">Rp {fmt(Math.round(base))}</span>
              {" + fee "}
              <span className="font-semibold text-foreground">Rp {fmt(Math.round(fee))}</span>
              {` = Rp ${fmt(Math.round(raw))}`}
            </p>
            <p className="text-xs text-gray-500 tabular-nums">
              rounded up to {fmt(rounding)} → price{" "}
              <span className="font-semibold text-foreground">Rp {fmt(Math.round(price))}</span>
            </p>
            {/* The round-up lands in profit, not cost, so a small base can show a
                margin well above the bracket's own fee. */}
            {Math.round(price) !== Math.round(raw) && (
              <p className="text-[11px] text-gray-400 tabular-nums">
                The rounding added Rp {fmt(Math.round(price - raw))} on top of the fee.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-500 tabular-nums">
            Base cost <span className="font-semibold text-foreground">Rp {fmt(Math.round(base))}</span>
            {" → fee "}
            <span className="font-semibold text-foreground">Rp {fmt(Math.round(fee))}</span>
          </p>
        )}

        {brackets != null && active == null && sorted.length > 0 && (
          <p className="text-[11px] text-amber-700 tabular-nums">
            No bracket covers this — the lowest starts at {fmt2(sorted[0].minBase)}.
          </p>
        )}
        {overridden && entered != null && (
          <p className="text-[11px] text-amber-700 tabular-nums">
            Field says Rp {fmt(Math.round(entered))} — typed in, so the bracket is not
            applied.
          </p>
        )}
      </div>

      <p className="text-[10px] text-gray-400">
        {rounding ? (
          <>
            Brackets are edited under Settings → Pricing and the rounding step under
            Product defaults. Both are read when the product is saved.
          </>
        ) : (
          <>
            Brackets are edited under Settings → Pricing. Changing them never reprices
            an existing product.
          </>
        )}
      </p>
    </InfoPopover>
  )
}

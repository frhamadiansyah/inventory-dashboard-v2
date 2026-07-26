"use client"

// Shows which Tier Fee bracket the typed base amount lands in, and what the other
// brackets would charge — so the fee isn't a number with no explanation.
//
// Serves both of the method's modes, because they are one concept with two units:
//
//   rupiah mode — `unit` is "Rp", `entered` is the typed fee, and the panel calls out
//                 an override, since the field is only ever pre-filled.
//   valas mode  — `unit` is the country's currency and `conversion` is supplied, so
//                 the panel also shows the fee being converted and rounded into a
//                 rupiah price. Nothing is overridable there: the server resolves it.
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
  conversion,
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
  /** Valas mode only. Absent means no conversion is applied. */
  conversion?: { kurs: number; roundTo: number; countryName: string }
  disabled?: boolean
}) {
  const active = pickTierFeeBracket(brackets ?? [], base)
  const fee = tierFeeAmount(active, base)
  const sorted = [...(brackets ?? [])].sort((a, b) => a.minBase - b.minBase)
  const overridden = entered != null && Math.round(entered) !== Math.round(fee)

  const raw = conversion ? (base + fee) * conversion.kurs : 0
  const price = conversion ? ceilTo(raw, conversion.roundTo) : base + fee

  return (
    <InfoPopover
      ariaLabel="Show Tier Fee brackets"
      disabled={disabled}
      width={conversion ? 320 : 300}
    >
      <p className="text-xs font-semibold text-foreground">
        Tier Fee brackets{conversion ? ` — ${conversion.countryName}` : ""}
      </p>

      {brackets == null ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className={`text-xs ${conversion ? "text-amber-700" : "text-gray-500"}`}>
          {conversion
            ? `No brackets for ${conversion.countryName}, so the fee is 0 and this product is priced at cost.`
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
        {conversion ? (
          <>
            <p className="text-xs text-gray-500 tabular-nums">
              ({fmt2(base)} + fee <span className="font-semibold text-foreground">{fmt2(fee)}</span>)
              {` × ${fmt(conversion.kurs)} = Rp ${fmt(Math.round(raw))}`}
            </p>
            <p className="text-xs text-gray-500 tabular-nums">
              rounded up to {fmt(conversion.roundTo)} → price{" "}
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
        {conversion ? (
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

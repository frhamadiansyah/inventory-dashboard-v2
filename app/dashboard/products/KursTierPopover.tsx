"use client"

// Shows which Tier Kurs bracket the typed valas lands in, what rate that charges
// against the country's actual rate, and the price it produces.
//
// Used by both the Add form and the Edit modal. Panel chrome and positioning come
// from InfoPopover, shared with TierFeePopover.
//
// Unlike the Tier Fee brackets these ARE a pricing authority: the server re-resolves
// them on every save, so this panel is showing the rate that will actually be
// stored, not a suggestion.

import InfoPopover from "@/components/InfoPopover"
import { pickKursTier, tiersForCountry } from "@/lib/kurs-tiers"
import { calcTierKursPrice } from "@/lib/pricing"
import type { CountryRow, KursTierRow } from "@/lib/db"

const fmt = (n: number) => n.toLocaleString("id-ID")

export default function KursTierPopover({
  country,
  valas,
  gram,
  tiers,
  packingFee,
  roundTo,
  disabled,
}: {
  country: CountryRow | null | undefined
  valas: number
  /** Shipping weight — part of cost since freight is booked into cogs. */
  gram: number
  /** Every country's brackets; filtered here. */
  tiers: KursTierRow[]
  roundTo: number
  /** Same packing charge the form is using, so the panel's price matches the field. */
  packingFee: number
  disabled?: boolean
}) {
  const forCountry = country ? tiersForCountry(tiers, country.id) : []
  const active = pickKursTier(forCountry, valas)
  // Same fallback rule as the form and the server: no bracket means the flat rate,
  // which prices the product at cost with a zero spread.
  const charged = active ? Number(active.kurs) : (country?.kurs ?? 0)
  const { cogs, price } = calcTierKursPrice({
    valas,
    tieredKurs: charged,
    kurs: country?.kurs ?? 0,
    gram,
    cargoPerKg: country?.cargoPerKg ?? 0,
    packingFee,
    roundTo,
  })
  const raw = valas * charged

  return (
    <InfoPopover ariaLabel="Show Tier Kurs brackets" disabled={disabled} width={320}>
      <p className="text-xs font-semibold text-foreground">
        Tier Kurs brackets{country ? ` — ${country.name}` : ""}
      </p>

      {!country ? (
        <p className="text-xs text-gray-500">Select a country to see its brackets.</p>
      ) : forCountry.length === 0 ? (
        <p className="text-xs text-amber-700">
          No brackets for {country.name}, so the flat rate {fmt(country.kurs)} is charged
          and there is no margin. Add them under Settings → Pricing.
        </p>
      ) : (
        <div className="flex flex-col">
          {forCountry.map((t) => {
            const isActive = active != null && t.id === active.id
            const markup = country.kurs > 0 ? (t.kurs / country.kurs - 1) * 100 : null
            return (
              <div
                key={t.id}
                className={`flex items-center justify-between gap-2 px-2 py-1 rounded-md text-xs tabular-nums ${
                  isActive ? "bg-brand/10 text-foreground font-medium" : "text-gray-500"
                }`}
              >
                <span>from {fmt(t.minValas)}</span>
                <span className="flex items-center gap-2">
                  <span>{fmt(t.kurs)}</span>
                  {markup != null && (
                    <span className={markup >= 0 ? "text-green-700" : "text-red-600"}>
                      {markup >= 0 ? "+" : ""}{markup.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {country && (
        <div className="border-t border-cream-border pt-2 flex flex-col gap-1">
          <p className="text-xs text-gray-500 tabular-nums">
            valas <span className="font-semibold text-foreground">{fmt(valas)}</span>
            {" × charged "}
            <span className="font-semibold text-foreground">{fmt(charged)}</span>
            {" = Rp "}{fmt(Math.round(raw))}
          </p>
          <p className="text-xs text-gray-500 tabular-nums">
            rounded up to {fmt(roundTo)} → price{" "}
            <span className="font-semibold text-foreground">Rp {fmt(Math.round(price))}</span>
            {" · cost Rp "}{fmt(Math.round(cogs))}
            {" · profit "}
            <span className={price - cogs >= 0 ? "text-green-700" : "text-red-600"}>
              Rp {fmt(Math.round(price - cogs))}
            </span>
          </p>
          {/* Worth calling out: the round-up lands in profit, not cost, so a small
              valas can show a margin well above the bracket's own markup. */}
          {Math.round(price) !== Math.round(raw) && (
            <p className="text-[11px] text-gray-400 tabular-nums">
              The rounding added Rp {fmt(Math.round(price - raw))} of profit.
            </p>
          )}
          {active == null && forCountry.length > 0 && (
            <p className="text-[11px] text-amber-700 tabular-nums">
              No bracket covers this valas — the lowest starts at {fmt(forCountry[0].minValas)},
              so the flat rate is used.
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] text-gray-400">
        Brackets are edited under Settings → Pricing, and the rounding step under
        Product defaults. Both are read when the product is saved.
      </p>
    </InfoPopover>
  )
}

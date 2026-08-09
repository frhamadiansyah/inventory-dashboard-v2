"use client"

// Explains the rate a Rate product is charged, and the price it produces.
//
// Two modes, matching the two methods: "tier" shows which bracket the typed valas lands in;
// "flat" shows the country's single configured rate. The worked example below is shared —
// it is the same formula either way, and only the rate above it differs.
//
// Used by both the Add form and the Edit modal. Panel chrome and positioning come
// from InfoPopover, shared with TierFeePopover.
//
// Unlike the Tier Fee brackets these ARE a pricing authority: the server re-resolves
// them on every save, so this panel is showing the rate that will actually be
// stored, not a suggestion.

import InfoPopover from "@/components/InfoPopover"
import { pickKursTier, tiersForCountry, resolveFlatKurs } from "@/lib/kurs-tiers"
import { calcKursPrice } from "@/lib/pricing"
import type { CountryRow, KursTierRow } from "@/lib/db"

const fmt = (n: number) => n.toLocaleString("id-ID")

export default function KursTierPopover({
  country,
  mode,
  costRate,
  valas,
  gram,
  tiers,
  packingFee,
  roundTo,
  disabled,
}: {
  country: CountryRow | null | undefined
  /** Which Rate method is selected. Decides what the panel explains, not how it computes. */
  mode: "tier" | "flat"
  /** The rate this row books as COST — the caller's costRate / tierKursCostRate, which is
   *  what it will send as body.kurs. Passed in rather than derived from country.kurs so the
   *  unset-flat-rate fallback here is the same figure the form and the server use; deriving
   *  it would make this panel disagree with the Price field beside it whenever a live rate
   *  is in play. */
  costRate: number
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
  const flat = mode === "flat"
  const forCountry = country ? tiersForCountry(tiers, country.id) : []
  const active = flat ? null : pickKursTier(forCountry, valas)
  // Same fallback rule as the form and the server, for both methods: nothing configured
  // means the cost rate, which prices the product at cost with a zero spread.
  const charged = flat
    ? resolveFlatKurs(country?.flatKurs, costRate)
    : active ? Number(active.kurs) : (country?.kurs ?? 0)
  const flatSet = flat && country != null && Number(country.flatKurs) > 0
  const { cogs, price } = calcKursPrice({
    valas,
    chargedKurs: charged,
    kurs: country?.kurs ?? 0,
    gram,
    cargoPerKg: country?.cargoPerKg ?? 0,
    packingFee,
    roundTo,
  })
  const raw = valas * charged

  return (
    <InfoPopover
      ariaLabel={flat ? "Show the flat rate" : "Show Tier Rate brackets"}
      disabled={disabled}
      width={320}
    >
      <p className="text-xs font-semibold text-foreground">
        {flat ? "Flat Rate" : "Tier Rate brackets"}{country ? ` — ${country.name}` : ""}
      </p>

      {!country ? (
        <p className="text-xs text-gray-500">
          Select a country to see {flat ? "its rate" : "its brackets"}.
        </p>
      ) : flat ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-gray-500">
            One rate for the whole country, whatever the valas.
          </p>
          {flatSet ? (
            <p className="text-xs tabular-nums text-gray-500">
              <span className="font-semibold text-foreground">{fmt(charged)}</span> charged ·{" "}
              {fmt(country.kurs)} cost
              {country.kurs > 0 && (
                <span className={charged >= country.kurs ? " text-green-700" : " text-red-600"}>
                  {" "}{charged >= country.kurs ? "+" : ""}
                  {((charged / country.kurs - 1) * 100).toFixed(1)}%
                </span>
              )}
            </p>
          ) : (
            <p className="text-xs text-amber-700">
              {country.name} has no flat rate set, so these products are charged{" "}
              {fmt(charged)}, the rate their cost is booked at, and there is no margin beyond
              the round-up. Set one under Settings → Pricing.
            </p>
          )}
        </div>
      ) : forCountry.length === 0 ? (
        <p className="text-xs text-amber-700">
          No brackets for {country.name}, so the cost rate {fmt(country.kurs)} is charged
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
          {!flat && active == null && forCountry.length > 0 && (
            <p className="text-[11px] text-amber-700 tabular-nums">
              No bracket covers this valas — the lowest starts at {fmt(forCountry[0].minValas)},
              so the cost rate is used.
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] text-gray-400">
        {flat ? "The flat rate is" : "Brackets are"} edited under Settings → Pricing, and the
        rounding step at the top of that same card. Both are read when the product is saved.
      </p>
    </InfoPopover>
  )
}

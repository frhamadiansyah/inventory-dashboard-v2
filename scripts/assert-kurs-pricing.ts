// Assertions for the shared Rate math. No database, no imports beyond the two pure
// modules under test, so it runs anywhere:
//
//   node --import=tsx scripts/assert-kurs-pricing.ts
//
// Exists because this project has no test framework and the flat-rate fallback is the one
// piece of new logic in the feature with a branch worth pinning down.

import { calcKursPrice, kursProfit, ceilTo } from "../lib/pricing"
import { resolveFlatKurs, resolveTieredKurs } from "../lib/kurs-tiers"

let failures = 0
function eq(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}

// ─── resolveFlatKurs ───────────────────────────────────────────────────────
eq("a set rate is charged", resolveFlatKurs(230, 118), 230)
eq("postgres NUMERIC arrives as a string", resolveFlatKurs("230.5000", 118), 230.5)
eq("0 means unset, so charge the cost rate", resolveFlatKurs(0, 118), 118)
eq("null means unset", resolveFlatKurs(null, 118), 118)
eq("undefined means unset", resolveFlatKurs(undefined, 118), 118)
eq("a negative rate is not a rate", resolveFlatKurs(-5, 118), 118)
eq("an unparseable rate is not a rate", resolveFlatKurs("abc", 118), 118)

// ─── calcKursPrice, shared by both Rate methods ───────────────────────────
// Flat: 1000 × 230 + 2500 = 232500, ceil to 5000 → 235000.
const flat = calcKursPrice({
  valas: 1000, chargedKurs: 230, kurs: 118,
  gram: 0, cargoPerKg: 0, packingFee: 2500, roundTo: 5000,
})
eq("flat price rounds up to the step", flat.price, 235000)
eq("flat cogs books the COST rate, not the charged one", flat.cogs, 118000)

// The unset case must price at cost: charged rate == cost rate leaves only the packing
// fee and the round-up as margin.
const unset = calcKursPrice({
  valas: 1000, chargedKurs: resolveFlatKurs(0, 118), kurs: 118,
  gram: 0, cargoPerKg: 0, packingFee: 0, roundTo: 5000,
})
eq("an unset rate prices at cost", unset.price, ceilTo(unset.cogs, 5000))
eq("an unset rate leaves only the round-up as profit",
   kursProfit({ ...unset, packingFee: 0 }), ceilTo(118000, 5000) - 118000)

// Freight lands in cogs but never in price — see calcKursPrice's own comment.
const heavy = calcKursPrice({
  valas: 1000, chargedKurs: 230, kurs: 118,
  gram: 2000, cargoPerKg: 350000, packingFee: 0, roundTo: 5000,
})
eq("freight raises cogs", heavy.cogs, 118000 + 700000)
eq("freight does not raise price", heavy.price, 230000)
eq("a heavy cheap item can lose money", kursProfit({ ...heavy, packingFee: 0 }) < 0, true)

// ─── the two resolvers agree on their fallback contract ──────────────────
eq("no brackets falls back the same way an unset flat rate does",
   resolveTieredKurs([], 1000, 118), resolveFlatKurs(0, 118))

console.log(failures === 0 ? "\nall assertions passed" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

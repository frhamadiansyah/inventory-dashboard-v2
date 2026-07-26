"use client"

// Live mid-market rate for a 3-letter currency → IDR, via the free, keyless
// open.er-api.com (CORS-friendly). Returns null until a valid code is entered.
//
// Lifted out of CountriesClient unchanged, because the product form needs the same
// figure: a country's "markup rate" is this rate times product_defaults.markup_pct,
// and that is what Tier Kurs books its cost at.
//
// Deliberately has no cache and no retry. It is a browser-side convenience read; every
// consumer must have a stored fallback for when it returns null, because a third-party
// endpoint being reachable is not something a price can depend on.

import { useEffect, useState } from "react"

export function useLiveIdrRate(currency: string) {
  const [rate, setRate] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const code = currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code) || code === "IDR") { setRate(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    fetch(`https://open.er-api.com/v6/latest/${code}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setRate(d?.result === "success" && typeof d.rates?.IDR === "number" ? d.rates.IDR : null)
      })
      .catch(() => { if (!cancelled) setRate(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [currency])
  return { rate, loading }
}

/** The rate a product is costed at: the live rate plus the configured markup, rounded
 *  to the 2dp it is displayed at so the shown rate and the arithmetic agree. Null when
 *  there is no live rate to mark up — callers fall back to the stored country rate. */
export function markupRate(live: number | null, markupPct: number): number | null {
  if (live == null || !Number.isFinite(live)) return null
  return Math.round(live * (1 + markupPct / 100) * 100) / 100
}

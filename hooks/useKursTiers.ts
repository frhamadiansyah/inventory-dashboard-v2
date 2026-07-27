"use client"

import { useCallback, useEffect, useState } from "react"
import type { KursTierRow } from "@/lib/db"

/**
 * Every Tier Kurs bracket, for every country. The product form needs them to
 * preview the rate a typed valas will actually be charged, and the Settings
 * editor needs them to edit.
 *
 * One hook for both, so there is a single fetch path and a single invalidation
 * story. `reload` lets the Settings editor refresh after a save without a full
 * remount, the same shape as usePricingTemplates.
 */
export function useKursTiers(): {
  tiers: KursTierRow[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
} {
  const [tiers, setTiers] = useState<KursTierRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/kurs-tiers", { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load kurs tiers")
      setTiers(json.tiers as KursTierRow[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load kurs tiers")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  return { tiers, loading, error, reload }
}

"use client"

import { useCallback, useEffect, useState } from "react"
import type { TierFeeBracketRow } from "@/lib/db"

/**
 * The Tier Fee brackets, every scope — the rupiah set (countryId null) and each
 * country's valas set. The product forms need them to show the fee a typed base
 * amount earns, and the Settings editor needs them to edit; one hook for both, so
 * there is a single fetch path and a single invalidation story. Same shape as
 * useKursTiers.
 *
 * `brackets` is null until the first response lands, which the form uses to tell
 * "still loading" (fall back to the pre-migration rupiah defaults) apart from
 * "loaded, and the owner has none" (suggest nothing). Filter by scope with
 * bracketsForScope() from lib/tier-fee.ts.
 */
export function useTierFeeBrackets(): {
  brackets: TierFeeBracketRow[] | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
} {
  const [brackets, setBrackets] = useState<TierFeeBracketRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/tier-fee-brackets", { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load fee brackets")
      setBrackets(json.brackets as TierFeeBracketRow[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fee brackets")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  return { brackets, loading, error, reload }
}

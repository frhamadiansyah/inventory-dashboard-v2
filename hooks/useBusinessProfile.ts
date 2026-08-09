"use client"

import { useEffect, useState } from "react"
import type { BusinessProfile } from "@/lib/business-profile"

// Module-level cache: mounted per-row on the ship/shipments pages, same
// reasoning as useMessageTemplates — one shared GET per session instead of
// one per row.
let cached: BusinessProfile | null = null
let inflight: Promise<BusinessProfile | null> | null = null

function loadProfile(): Promise<BusinessProfile | null> {
  if (cached) return Promise.resolve(cached)
  inflight ??= fetch("/api/sheets/business-profile", { cache: "no-store" })
    .then((r) => r.json())
    .then((data: { profile?: BusinessProfile; error?: string }) => {
      if (!data.error && data.profile) {
        cached = data.profile
        return cached
      }
      inflight = null
      return null
    })
    .catch(() => {
      inflight = null
      return null
    })
  return inflight
}

export function useBusinessProfile(): BusinessProfile | null {
  const [profile, setProfile] = useState<BusinessProfile | null>(cached)
  useEffect(() => {
    if (profile) return
    let alive = true
    loadProfile().then((p) => {
      if (alive && p) setProfile(p)
    })
    return () => { alive = false }
  }, [profile])
  return profile
}

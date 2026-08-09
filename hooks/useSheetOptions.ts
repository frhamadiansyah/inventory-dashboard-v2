"use client"

import { useEffect, useState } from "react"
import type { SheetOptions } from "@/lib/db"

export function useSheetOptions(): SheetOptions | null {
  const [options, setOptions] = useState<SheetOptions | null>(null)
  useEffect(() => {
    // no-store: this list (products/customers/events) changes often; a cached
    // copy makes newly-added items silently missing from the pickers.
    fetch("/api/sheets/options", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: SheetOptions & { error?: string }) => {
        if (!data.error) setOptions(data)
      })
      .catch(() => {})
  }, [])
  return options
}

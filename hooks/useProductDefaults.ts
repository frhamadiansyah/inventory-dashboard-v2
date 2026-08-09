"use client"

import { useEffect, useState } from "react"
import type { ProductDefaults } from "@/lib/product-defaults"

export function useProductDefaults(): ProductDefaults | null {
  const [defaults, setDefaults] = useState<ProductDefaults | null>(null)
  useEffect(() => {
    fetch("/api/sheets/product-defaults", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { defaults?: ProductDefaults; error?: string }) => {
        if (!data.error && data.defaults) setDefaults(data.defaults)
      })
      .catch(() => {})
  }, [])
  return defaults
}

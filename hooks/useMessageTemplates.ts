"use client"

import { useEffect, useState } from "react"
import type { TemplateKey } from "@/lib/message-templates"

// Module-level cache: several components mount this hook per row (copy buttons
// on the ship/shipments pages), so without it every row fires its own GET.
// One shared in-flight promise per session; a failed fetch clears it so the
// next mount can retry.
let cached: Record<TemplateKey, string> | null = null
let inflight: Promise<Record<TemplateKey, string> | null> | null = null

function loadTemplates(): Promise<Record<TemplateKey, string> | null> {
  if (cached) return Promise.resolve(cached)
  inflight ??= fetch("/api/sheets/message-templates", { cache: "no-store" })
    .then((r) => r.json())
    .then((data: { templates?: Record<TemplateKey, string>; error?: string }) => {
      if (!data.error && data.templates) {
        cached = data.templates
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

export function useMessageTemplates(): Record<TemplateKey, string> | null {
  const [templates, setTemplates] = useState<Record<TemplateKey, string> | null>(cached)
  useEffect(() => {
    if (templates) return
    let alive = true
    loadTemplates().then((t) => {
      if (alive && t) setTemplates(t)
    })
    return () => { alive = false }
  }, [templates])
  return templates
}

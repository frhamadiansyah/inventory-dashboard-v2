"use client"

import { useCopyFeedback } from "@/hooks/useCopyFeedback"

/** Small inline copy-to-clipboard icon button. Copies `value`, briefly showing
 *  a green check. Stops row-click propagation so it works inside clickable rows. */
export default function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const { copied, copy } = useCopyFeedback()
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copy(value) }}
      title={label}
      aria-label={label}
      className="shrink-0 p-0.5 rounded text-gray-300 hover:text-brand transition-colors"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

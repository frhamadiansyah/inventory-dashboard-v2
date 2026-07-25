"use client"

import type { ReactNode } from "react"

export type SelectionAction = {
  label: string
  icon: ReactNode
  onClick: () => void
  /** Tailwind color word driving the icon circle + label tint, e.g. "green", "blue", "brand". */
  color: "brand" | "green" | "blue" | "red" | "amber"
  disabled?: boolean
}

const COLOR_CLASSES: Record<SelectionAction["color"], { bg: string; text: string }> = {
  brand: { bg: "bg-brand/10", text: "text-brand" },
  green: { bg: "bg-green-100", text: "text-green-700" },
  blue: { bg: "bg-blue-100", text: "text-blue-700" },
  red: { bg: "bg-red-100", text: "text-red-600" },
  amber: { bg: "bg-amber-100", text: "text-amber-700" },
}

// Floating bottom bar shown while rows are multi-selected. Count + Clear on the
// left, one icon-over-label button per bulk action on the right — same shape
// on mobile and desktop.
export default function SelectionActionBar({
  count,
  onClear,
  actions,
  reserveFab = false,
}: {
  count: number
  onClear: () => void
  actions: SelectionAction[]
  /** Keep the original mobile position offset to the left (left-4 right-20) so
   *  the bar clears a bottom-right FAB. Off = centered on mobile. Desktop is
   *  always centered. */
  reserveFab?: boolean
}) {
  return (
    <div className={`fixed z-40 h-14 flex items-center justify-center gap-3 md:gap-2 rounded-2xl bg-white/90 backdrop-blur border border-cream-border text-foreground shadow-xl px-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden bottom-20 md:bottom-4 md:left-1/2 md:right-auto md:-translate-x-1/2 ${reserveFab ? "left-4 right-20" : "left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)]"}`}>
      <div className="flex flex-col md:flex-row items-center justify-center gap-0.5 md:gap-2 px-2 shrink-0">
        <span className="w-7 h-7 rounded-full flex items-center justify-center bg-brand/10 text-brand font-bold text-xs tabular-nums">
          {count}
        </span>
        <span className="text-[10px] md:text-xs font-medium text-gray-500 leading-none whitespace-nowrap">Selected</span>
      </div>
      <div className="w-px h-8 bg-cream-border shrink-0" />
      {actions.map((a, i) => {
        const cls = COLOR_CLASSES[a.color]
        return (
          <button
            key={i}
            type="button"
            onClick={a.onClick}
            disabled={a.disabled}
            className="flex flex-col md:flex-row items-center justify-center gap-0.5 md:gap-2 px-2 md:pl-1.5 md:pr-3 py-0.5 md:py-1.5 rounded-xl md:rounded-full hover:bg-cream transition-colors disabled:opacity-40 shrink-0"
          >
            <span className={`w-7 h-7 rounded-full flex items-center justify-center ${cls.bg} ${cls.text}`}>
              {a.icon}
            </span>
            <span className={`text-[10px] md:text-xs font-medium leading-none whitespace-nowrap ${cls.text}`}>{a.label}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="flex flex-col md:flex-row items-center justify-center gap-0.5 md:gap-2 px-2 py-0.5 rounded-xl hover:bg-cream transition-colors shrink-0"
      >
        <span className="w-7 h-7 rounded-full flex items-center justify-center bg-cream text-gray-500">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </span>
        <span className="text-[10px] md:text-xs font-medium text-gray-500 leading-none whitespace-nowrap">Clear</span>
      </button>
    </div>
  )
}

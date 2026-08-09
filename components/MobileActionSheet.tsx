"use client"

import type { ReactNode } from "react"

export type ActionSheetItem = {
  label: string
  icon: ReactNode
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}

// Mobile-only bottom sheet for a row's actions (Edit/Delete/etc). Reuses the
// rounded-t-2xl bottom-sheet pattern already used by the mobile "add" sheets
// across the app, so it feels consistent rather than introducing a new shape.
export default function MobileActionSheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
}: {
  open: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  actions: ActionSheetItem[]
}) {
  if (!open) return null

  return (
    <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={onClose}>
      <div className="w-full bg-white rounded-t-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {(title || subtitle) && (
          <div className="px-4 py-3 border-b border-cream-border">
            {title && <div className="text-sm font-semibold text-foreground truncate">{title}</div>}
            {subtitle && <div className="text-xs text-gray-500 mt-0.5 truncate">{subtitle}</div>}
          </div>
        )}
        <div className="py-1">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { onClose(); a.onClick() }}
              disabled={a.disabled}
              className={`w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-left active:bg-cream disabled:opacity-50 transition-colors ${
                a.destructive ? "text-red-600" : "text-foreground"
              }`}
            >
              <span className={a.destructive ? "text-red-500" : "text-gray-400"}>{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
        <div className="p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t border-cream-border">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl bg-cream text-sm font-medium text-gray-600 active:bg-cream/70 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

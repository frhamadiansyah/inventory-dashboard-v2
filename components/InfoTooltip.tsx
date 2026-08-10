"use client"

import { useEffect, useRef, useState } from "react"

const POPUP_WIDTH = 224 // w-56

// Click/tap-to-toggle rather than hover-only, so it works the same on touch as on desktop.
export default function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  function handleToggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      // Anchored to the trigger's right edge (right-0) used to clip off-screen whenever the
      // icon sat anywhere near the left of a narrow (mobile) viewport, since the popup only
      // ever extended further left from there. Clamping a fixed-position left offset within
      // the viewport, instead of anchoring to a CSS edge, keeps it on-screen regardless of
      // where the icon actually is.
      const left = Math.min(Math.max(rect.right - POPUP_WIDTH, 8), window.innerWidth - POPUP_WIDTH - 8)
      setPopupStyle({ position: "fixed", top: rect.bottom + 4, left })
    }
    setOpen((o) => !o)
  }

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-label="More info"
        className="flex items-center justify-center w-4 h-4 rounded-full text-gray-400 hover:text-brand transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && (
        <div
          ref={popupRef}
          style={{ ...popupStyle, width: POPUP_WIDTH }}
          className="z-20 rounded-lg border border-cream-border bg-white shadow-lg p-2.5 text-[10px] text-gray-500 leading-relaxed"
        >
          {text}
        </div>
      )}
    </div>
  )
}

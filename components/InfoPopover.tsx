"use client"

// A small "i" button that opens a panel next to it. Content-agnostic — callers
// supply the body.
//
// The panel is position:fixed and positioned from the button's rect rather than
// absolute, because callers include the product edit modal, an overflow-y-auto
// container that would clip an absolutely positioned child. Close-on-outside-
// pointerdown, Escape, and reposition-on-scroll follow SearchableSelect's dropdown.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

export default function InfoPopover({
  ariaLabel,
  width = 300,
  disabled,
  children,
}: {
  ariaLabel: string
  width?: number
  disabled?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const position = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Right-aligned to the button, clamped into the viewport with an 8px margin.
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    setPos({ top: r.bottom + 6, left })
  }, [width])

  useEffect(() => {
    if (!open) return
    position()
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    const reposition = () => position()
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
    }
  }, [open, position])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // 13px, small enough to sit inside a text-xs label line (1rem) with room to
        // spare. The panel is positioned off getBoundingClientRect, so it follows any
        // size change on its own.
        //
        // The glyph is 8px rather than the proportional 7: below 8 the "i" stops being
        // legible, and it is the only thing identifying the button.
        //
        // before:-inset-1.5 restores a ~25px pointer target around a 13px circle. The
        // pseudo-element is absolutely positioned, so it costs no layout — without it
        // the visible size IS the hit area, which is well under any usable minimum.
        className={`relative shrink-0 w-[13px] h-[13px] inline-flex items-center justify-center rounded-full border text-[8px] font-semibold transition-colors disabled:opacity-40 before:absolute before:-inset-1.5 before:content-[''] ${
          open ? "border-brand text-brand" : "border-cream-border text-gray-400 hover:border-brand hover:text-brand"
        }`}
      >
        i
      </button>

      {open && pos && (
        <div
          ref={panelRef}
          role="dialog"
          style={{ top: pos.top, left: pos.left, width }}
          className="fixed z-[60] bg-white border border-cream-border rounded-xl shadow-xl p-3 flex flex-col gap-2"
        >
          {children}
        </div>
      )}
    </>
  )
}

"use client"

import { useState, useRef, useEffect, useMemo, useCallback, memo } from "react"

export interface SelectOption {
  value: string
  label: string
  /** Secondary text shown alongside the label (e.g. store name for items) */
  meta?: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  /** Show a clear/reset option at the top of the list that sets value to "" */
  clearable?: boolean
  /** Allow typing a value that doesn't exist in options and committing it */
  allowNewValue?: boolean
  /** Show the full list when there's no query, even for large lists (no "type to search" gate) */
  alwaysShowAll?: boolean
  /** Click-only mode: no typing/filtering, just open the list and pick. */
  searchable?: boolean
  /** Shorter trigger input (34px) instead of the default 38px */
  dense?: boolean
}

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  clearable = false,
  allowNewValue = false,
  alwaysShowAll = false,
  searchable = true,
  dense = false,
}: Props) {
  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? (allowNewValue ? value : ""),
    [options, value, allowNewValue],
  )

  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState(selectedLabel)
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})

  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Sync input display when selection changes externally (or on mount)
  useEffect(() => {
    if (!open) setInputValue(selectedLabel)
  }, [selectedLabel, open])

  // Stable refs so closeDropdown doesn't re-create on every keystroke
  const inputValueRef = useRef(inputValue)
  useEffect(() => { inputValueRef.current = inputValue }, [inputValue])

  const selectedLabelRef = useRef(selectedLabel)
  useEffect(() => { selectedLabelRef.current = selectedLabel }, [selectedLabel])

  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])

  // ---------- Filtering ----------

  const LARGE_LIST = options.length > 100

  const [debouncedQuery, setDebouncedQuery] = useState("")
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(inputValue.trim().toLowerCase()), 200)
    return () => clearTimeout(id)
  }, [inputValue])

  const hasQuery = inputValue.trim().length > 0
  const filtered = useMemo(() => {
    // Click-only mode never filters — always show the full list.
    if (!searchable) return options
    if (debouncedQuery) return options.filter((o) => o.label.toLowerCase().includes(debouncedQuery))
    if (LARGE_LIST && !alwaysShowAll) return []
    return options
  }, [debouncedQuery, options, LARGE_LIST, alwaysShowAll, searchable])

  useEffect(() => { setHighlightIdx((i) => (i === -1 ? i : -1)) }, [filtered])

  // ---------- Open / close ----------

  function positionPopup() {
    const rect = inputRef.current?.getBoundingClientRect()
    if (!rect) return
    const POPUP_HEIGHT = 260
    // Decide above/below using the *visible* height (visualViewport shrinks when
    // the mobile keyboard is open; window.innerHeight does not) so the list never
    // opens behind the keyboard. The fixed `bottom` anchor stays keyed to the
    // layout viewport (window.innerHeight), which is what position:fixed uses.
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight
    const spaceBelow = visibleHeight - rect.bottom
    if (spaceBelow < POPUP_HEIGHT && rect.top > POPUP_HEIGHT) {
      setPopupStyle({ position: "fixed", bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width })
    } else {
      setPopupStyle({ position: "fixed", top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
  }

  function openDropdown() {
    if (disabled || open) return
    positionPopup()
    setHighlightIdx(-1)
    // Keep the current selection visible instead of blanking the field. Focus
    // handling select-all's the text so typing still replaces it immediately.
    setOpen(true)
  }

  const closeDropdown = useCallback(() => {
    setOpen(false)
    if (allowNewValue) {
      const trimmed = inputValueRef.current.trim()
      if (trimmed) {
        // If it matches an existing option label (case-insensitive), select that option
        const match = optionsRef.current.find(
          (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
        )
        if (match) {
          onChangeRef.current(match.value)
          setInputValue(match.label)
        } else {
          // Commit the raw typed text as a new value
          onChangeRef.current(trimmed)
          setInputValue(trimmed)
        }
      } else {
        setInputValue(selectedLabelRef.current)
      }
    } else {
      setInputValue(selectedLabelRef.current)
    }
  }, [allowNewValue])

  const selectOption = useCallback(
    (val: string) => {
      onChange(val)
      const label = options.find((o) => o.value === val)?.label ?? val
      setInputValue(label)
      setOpen(false)
      inputRef.current?.blur()
    },
    [onChange, options],
  )

  // Close on click outside (sole close mechanism, no blur handler)
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (
        !wrapperRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        closeDropdown()
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [open, closeDropdown])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { closeDropdown(); inputRef.current?.blur() }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open, closeDropdown])

  // The popup is position:fixed, positioned from the input's rect at open time.
  // Re-run that positioning whenever the field could move so it tracks the field
  // instead of floating free:
  //  - window scroll (capture phase catches scrolling in any ancestor container)
  //  - window resize
  //  - visualViewport resize/scroll — the ONLY events the mobile keyboard fires
  //    when it opens/closes and pans the viewport. Without these the popup keeps
  //    its pre-keyboard coordinates and appears detached from the input.
  useEffect(() => {
    if (!open) return
    const reposition = () => positionPopup()
    window.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    const vv = window.visualViewport
    vv?.addEventListener("resize", reposition)
    vv?.addEventListener("scroll", reposition)
    return () => {
      window.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
      vv?.removeEventListener("resize", reposition)
      vv?.removeEventListener("scroll", reposition)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ---------- Input handlers ----------

  function handleFocus() {
    if (disabled) return
    openDropdown()
    // Select the displayed label so the user can type to search (replacing it)
    // without the field ever appearing empty. Only in searchable mode — in
    // click-only mode the input is readOnly, so selecting would leave a
    // pointless blue text highlight on the trigger.
    if (searchable) inputRef.current?.select()
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setInputValue(v)
    if (!open) openDropdown()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault()
        openDropdown()
      }
      return
    }

    const showClear = clearable && value && !hasQuery
    const clearOffset = showClear ? 1 : 0
    const showAddRow = allowNewValue && hasQuery && filtered.length === 0
    const total = filtered.length + clearOffset + (showAddRow ? 1 : 0)

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlightIdx((i) => (i + 1) % Math.max(total, 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlightIdx((i) => (i - 1 + Math.max(total, 1)) % Math.max(total, 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (highlightIdx >= 0 && highlightIdx < total) {
        if (clearOffset && highlightIdx === 0) {
          selectOption("")
        } else {
          const opt = filtered[highlightIdx - clearOffset]
          if (opt) selectOption(opt.value)
          else if (showAddRow) {
            // "Add" row is highlighted
            selectOption(inputValue.trim())
          }
        }
      } else if (filtered.length === 1 && debouncedQuery) {
        selectOption(filtered[0].value)
      } else if (allowNewValue && inputValue.trim()) {
        // Commit free-typed value directly
        selectOption(inputValue.trim())
      }
    }
  }

  // ---------- Render ----------

  const showClearRow = clearable && value && !hasQuery
  const showAddRow = allowNewValue && hasQuery && filtered.length === 0
  // Inline × on the trigger — one-click reset to "" without opening the list.
  const showInlineClear = clearable && !!value && !disabled

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onClick={() => { if (!searchable) openDropdown() }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={!searchable}
        autoComplete="off"
        className={`w-full border border-cream-border rounded-lg px-3 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${showInlineClear ? "pr-14" : "pr-8"} ${!searchable ? "cursor-pointer" : ""} ${dense ? "h-[34px] py-0 text-xs" : "py-2 text-sm"}`}
      />
      {showInlineClear && (
        <button
          type="button"
          aria-label="Clear"
          // mousedown (not click) + preventDefault so clearing doesn't focus the
          // input and pop the dropdown open. Matches OptionItem's select pattern.
          onMouseDown={(e) => { e.preventDefault(); selectOption("") }}
          className="absolute right-8 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      )}
      <svg
        className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none transition-transform ${open ? "rotate-180" : ""}`}
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clipRule="evenodd"
        />
      </svg>

      {open && (
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-50 bg-white border border-cream-border rounded-lg shadow-lg overflow-hidden"
        >
          <ul className="max-h-56 overflow-y-auto">
            {showClearRow && (
              <OptionItem
                label={placeholder}
                highlighted={highlightIdx === 0}
                selected={false}
                onSelect={() => selectOption("")}
                className="text-gray-400"
              />
            )}
            {LARGE_LIST && !alwaysShowAll && !debouncedQuery ? (
              <li className="px-3 py-3 text-sm text-gray-400 text-center">
                {hasQuery ? "Searching…" : "Type to search..."}
              </li>
            ) : showAddRow ? (
              <li
                onMouseDown={(e) => { e.preventDefault(); selectOption(inputValue.trim()) }}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer transition-colors ${
                  highlightIdx === 0 ? "bg-brand-light text-brand" : "text-foreground hover:bg-brand-light"
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span>Add <span className="font-medium">&ldquo;{inputValue.trim()}&rdquo;</span></span>
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-3 text-sm text-gray-400 text-center">
                No results
              </li>
            ) : (
              filtered.map((opt, i) => {
                const idx = i + (showClearRow ? 1 : 0)
                return (
                  <OptionItem
                    key={`${opt.value}-${i}`}
                    label={opt.label}
                    meta={opt.meta}
                    highlighted={highlightIdx === idx}
                    selected={value === opt.value}
                    onSelect={() => selectOption(opt.value)}
                  />
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------- OptionItem ----------

const OptionItem = memo(function OptionItem({
  label,
  meta,
  highlighted,
  selected,
  onSelect,
  className,
}: {
  label: string
  meta?: string
  highlighted: boolean
  selected: boolean
  onSelect: () => void
  className?: string
}) {
  const ref = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" })
  }, [highlighted])

  return (
    <li
      ref={ref}
      onMouseDown={(e) => {
        e.preventDefault()
        onSelect()
      }}
      className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors ${
        highlighted
          ? "bg-brand-light text-brand"
          : selected
            ? "bg-brand-light text-brand font-medium"
            : "text-foreground hover:bg-brand-light"
      } ${className ?? ""}`}
    >
      <span>{label}</span>
      {meta && (
        <span className="ml-2 shrink-0 text-xs text-gray-400">{meta}</span>
      )}
    </li>
  )
})

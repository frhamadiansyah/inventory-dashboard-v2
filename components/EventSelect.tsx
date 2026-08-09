"use client"

import { useMemo } from "react"
import SearchableSelect from "./SearchableSelect"

/**
 * Searchable event picker — same UX as the customer/product dropdowns, but the
 * full event list is always shown when there's no query (never gated behind a
 * "type to search" prompt). Events are a fixed set, so new values aren't allowed.
 */
export default function EventSelect({
  value,
  onChange,
  events,
  placeholder = "Select event…",
  disabled = false,
  clearable = false,
  dense = false,
}: {
  value: string
  onChange: (value: string) => void
  events: string[]
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  dense?: boolean
}) {
  const options = useMemo(() => events.map((e) => ({ value: e, label: e })), [events])
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      clearable={clearable}
      dense={dense}
      alwaysShowAll
    />
  )
}

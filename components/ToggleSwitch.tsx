"use client"

// Small controlled pill switch. On = brand maroon, off = gray. Used for the
// active/inactive toggle in the Events and Products tables.
export default function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label = "Toggle",
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/30 ${
        checked ? "bg-brand" : "bg-gray-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}

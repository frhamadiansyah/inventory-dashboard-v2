"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { signOutAction } from "@/lib/auth-actions"
import { Role } from "@/lib/roles"
import { canAccessRoute } from "@/lib/access"

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
}

type NavLink = { href: string; label: string; icon: React.ReactNode }
type NavSection = { section: string | null; items: NavLink[] }

const NAV_SECTIONS: NavSection[] = [
  {
    section: null,
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Database",
    items: [
      {
        href: "/dashboard/customers",
        label: "Customers",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        href: "/dashboard/countries",
        label: "Currencies",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        ),
      },
      {
        href: "/dashboard/events",
        label: "Events",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
          </svg>
        ),
      },
      {
        href: "/dashboard/products",
        label: "Products",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M12 22V12" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Input Order",
    items: [
      // TODO: re-enable Form Records once the page is ready
      // { href: "/dashboard/form-records", label: "Form Records", roles: ["admin", "owner"], icon: (...) }
      {
        href: "/dashboard/list-order",
        label: "Order",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        ),
      },
      {
        href: "/dashboard/invoice",
        label: "Invoice",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8" />
            <path d="M8 17h5" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Payments",
    items: [
      {
        href: "/dashboard/payments",
        label: "Payments",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        ),
      },
      {
        href: "/dashboard/adjustments",
        label: "Adjustments",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
        ),
      },
      {
        href: "/dashboard/refunds",
        label: "Refunds",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l4 2" />
          </svg>
        ),
      },
      {
        href: "/dashboard/operational-expenses",
        label: "Expenses",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20" />
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            <circle cx="12" cy="12" r="10" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Procurement",
    items: [
      {
        href: "/dashboard/shopping-list",
        label: "Shopping List",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="m9 14 2 2 4-4" />
          </svg>
        ),
      },
      {
        href: "/dashboard/dispatch-list",
        label: "Dispatch List",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        ),
      },
      {
        href: "/dashboard/arrival-list",
        label: "Receiving List",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        ),
      },
      {
        href: "/dashboard/excess-purchase",
        label: "Inventory",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h2l.4 2M7 13h10l4-8H5.4" />
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M9 13v4" />
            <path d="M15 13v4" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Shipping",
    items: [
      {
        href: "/dashboard/ship",
        label: "Packing List",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3" />
            <rect x="9" y="11" width="14" height="10" rx="1" />
            <path d="m12 17 3-3 3 3" />
            <path d="M15 14v6" />
          </svg>
        ),
      },
      {
        href: "/dashboard/shipments",
        label: "Shipments",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" />
            <path d="M16.5 9.4 7.55 4.24" />
            <polyline points="3.29 7 12 12 20.71 7" />
            <line x1="12" y1="22" x2="12" y2="12" />
            <circle cx="18.5" cy="15.5" r="2.5" />
            <path d="M20.27 17.27 22 19" />
          </svg>
        ),
      },
      {
        href: "/dashboard/custom-label",
        label: "Custom Label",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
            <path d="m19 16-4 4" />
            <path d="m19 20-4-4" />
          </svg>
        ),
      },
    ],
  },
  {
    section: "Settings",
    items: [
      {
        href: "/dashboard/settings",
        label: "Settings",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
      },
    ],
  },
]

interface Props {
  user: {
    name?: string | null
    email?: string | null
    role: Role | null
  }
}

export default function SidebarClient({ user }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const pathname = usePathname()

  const visibleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((l) => user.role !== null && canAccessRoute(user.role, l.href)) }))
    .filter((s) => s.items.length > 0)

  const initials = user.name
    ? user.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()
    : "?"

  function toggleSection(name: string) {
    setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  return (
    <aside
      className={`
        flex flex-col shrink-0 h-screen sticky top-0 bg-white border-r border-cream-border
        transition-all duration-200 ease-in-out
        ${collapsed ? "w-14" : "w-56"}
      `}
    >
      {/* Logo + toggle */}
      <div className="flex items-center h-14 px-3 border-b border-cream-border gap-2">
        <div className="w-7 h-7 shrink-0 rounded bg-brand flex items-center justify-center">
          <span className="text-white text-xs font-bold">Y</span>
        </div>
        {!collapsed && (
          <span className="font-semibold text-foreground text-sm truncate flex-1">Yubisayu</span>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="ml-auto text-gray-400 hover:text-brand transition-colors p-1 rounded"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* Nav links */}
      <nav className="flex-1 py-3 flex flex-col overflow-y-auto px-2">
        {visibleSections.map((section, si) => {
          const sectionCollapsed = section.section ? (collapsedSections[section.section] ?? false) : false
          return (
            <div key={si} className={si > 0 ? "mt-4" : ""}>
              {section.section && !collapsed && (
                <button
                  type="button"
                  onClick={() => toggleSection(section.section!)}
                  className="w-full flex items-center justify-between px-2 mb-1 group"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 group-hover:text-brand transition-colors select-none">
                    {section.section}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`text-gray-300 group-hover:text-brand transition-all duration-200 ${sectionCollapsed ? "-rotate-90" : ""}`}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
              {section.section && collapsed && (
                <div className="my-2 mx-auto w-4 border-t border-cream-border" />
              )}
              {!sectionCollapsed && (
                <div className="flex flex-col gap-0.5">
                  {section.items.map((link) => {
                    const isActive = pathname === link.href
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        title={collapsed ? link.label : undefined}
                        className={`
                          flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors
                          ${isActive
                            ? "bg-brand-light text-brand font-medium"
                            : "text-gray-600 hover:bg-brand-light hover:text-brand"
                          }
                          ${collapsed ? "justify-center" : ""}
                        `}
                      >
                        <span className="shrink-0">{link.icon}</span>
                        {!collapsed && <span className="truncate">{link.label}</span>}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Profile + sign out */}
      <div className="border-t border-cream-border p-3">
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3"}`}>
          <div
            className="w-8 h-8 rounded-full bg-brand flex items-center justify-center text-white text-xs font-semibold shrink-0"
            title={collapsed ? user.name ?? undefined : undefined}
          >
            {initials}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
              <p className="text-xs text-gray-400 truncate">
                {user.role ? ROLE_LABELS[user.role] : "User"}
              </p>
            </div>
          )}
        </div>
        {!collapsed && (
          <form action={signOutAction} className="mt-2">
            <button
              type="submit"
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-gray-500 hover:bg-brand-light hover:text-brand transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </form>
        )}
        {collapsed && (
          <form action={signOutAction} className="mt-2 flex justify-center">
            <button
              type="submit"
              title="Sign out"
              className="text-gray-400 hover:text-brand transition-colors p-1 rounded"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </form>
        )}
      </div>
    </aside>
  )
}

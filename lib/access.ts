import type { Role } from "./roles"

/**
 * Dashboard route prefixes an admin may access. Owners can access everything.
 * This is the single source of truth consumed by both the middleware (route
 * protection) and the sidebar (link visibility), so the two cannot drift apart.
 */
export const ADMIN_ROUTES = [
  "/dashboard/list-order",
  "/dashboard/invoice",
  "/dashboard/payments",
  "/dashboard/adjustments",
  "/dashboard/refunds",
  "/dashboard/ship", // Packing List
  "/dashboard/shipments",
  "/dashboard/custom-label",
  "/dashboard/customers",
  "/dashboard/excess-purchase", // Inventory (ready stock)
] as const

/** Where an admin lands after login and when redirected off a blocked route. */
export const ADMIN_HOME = "/dashboard/list-order"

export function canAccessRoute(role: Role, pathname: string): boolean {
  if (role === "owner") return true
  return ADMIN_ROUTES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

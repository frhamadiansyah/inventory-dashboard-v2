import { auth } from "@/auth"
import MobileNavClient from "./MobileNavClient"

// Bottom tab bar shown only on mobile (md:hidden). Role-filtered like the
// desktop sidebar so admins don't see owner-only tabs.
export default async function MobileNav() {
  const session = await auth()
  return (
    <MobileNavClient
      user={{
        name: session?.user?.name,
        email: session?.user?.email,
        role: session?.user?.role ?? null,
      }}
    />
  )
}

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import PaymentsClient from "./PaymentsClient"

export default async function PaymentsPage() {
  const session = await auth()
  const role = session?.user?.role ?? null
  return (
    <PageShell>
      <PageHeader
        title="Payments"
        subtitle="Track customer payments per event"
      />
      <PaymentsClient role={role} />
    </PageShell>
  )
}

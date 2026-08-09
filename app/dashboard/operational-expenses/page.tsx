import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import OperationalExpensesClient from "./OperationalExpensesClient"

export default function OperationalExpensesPage() {
  return (
    <PageShell>
      <PageHeader
        title="Expenses"
        subtitle="Track per-event operating and trip costs"
      />
      <OperationalExpensesClient />
    </PageShell>
  )
}

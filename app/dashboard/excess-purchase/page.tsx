import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ExcessTable from "./ExcessTable"

export default function ExcessPurchasePage() {
  return (
    <PageShell>
      <PageHeader
        title="Inventory"
        subtitle="Ready stock from overbuys, overships, and bad items"
      />
      <ExcessTable />
    </PageShell>
  )
}

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Inventory" subtitle="Ready stock — overbuys, overships, wrong-product and broken receipts" />
      <TableSkeleton />
    </PageShell>
  )
}

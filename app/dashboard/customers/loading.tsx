import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Customers" subtitle="View, add, and edit customer detail" />
      <TableSkeleton />
    </PageShell>
  )
}

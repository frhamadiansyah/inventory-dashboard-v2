import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="List Order" subtitle="View, edit, and delete orders" />
      <TableSkeleton />
    </PageShell>
  )
}

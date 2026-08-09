import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Arrival List" subtitle="Track which purchased items haven't arrived yet" />
      <TableSkeleton />
    </PageShell>
  )
}

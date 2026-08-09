import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Refunds" subtitle="Track and process customer refunds" />
      <TableSkeleton />
    </PageShell>
  )
}

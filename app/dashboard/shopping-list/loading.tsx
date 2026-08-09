import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Shopping List" subtitle="Items to buy — orders not yet purchased" />
      <TableSkeleton />
    </PageShell>
  )
}

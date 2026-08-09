import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Adjustments" subtitle="Extra fees and discounts per customer per event" />
      <TableSkeleton />
    </PageShell>
  )
}

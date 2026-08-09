import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Invoice" subtitle="Look up a customer's orders and invoice totals" />
      <TableSkeleton />
    </PageShell>
  )
}

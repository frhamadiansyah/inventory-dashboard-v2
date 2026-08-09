import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import CustomersClient from "./CustomersClient"

export default function CustomersPage() {
  return (
    <PageShell>
      <PageHeader
        title="Customers"
        subtitle="View, add, and edit customer detail"
      />
      <CustomersClient />
    </PageShell>
  )
}

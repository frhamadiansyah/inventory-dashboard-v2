import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import SettingsClient from "./SettingsClient"

export default function SettingsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Settings"
        subtitle="Edit the wording of customer-facing messages"
      />
      <SettingsClient />
    </PageShell>
  )
}

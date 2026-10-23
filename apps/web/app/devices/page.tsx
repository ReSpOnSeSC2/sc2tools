import { DevicesPanel } from "@/components/DevicesPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/Banner";

export const metadata = {
  title: "Devices",
};

export default function DevicesPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account" title="Devices" description="Link SC2 Tools on your gaming PC to sync your replays automatically." />
      <Banner variant="divider" />
      <DevicesPanel />
    </div>
  );
}

import { DevicesPanel } from "@/components/DevicesPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/Banner";

export const metadata = {
  title: "Devices",
};

export default function DevicesPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account" title="Devices" description="Link SC2 Tools on your gaming PC to sync your replays automatically. The pill at the top of the app shows whether your desktop app is online and when your latest game was played." />
      <Banner variant="divider" />
      <DevicesPanel />
    </div>
  );
}

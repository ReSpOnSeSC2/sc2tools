import { DevicesPanel } from "@/components/DevicesPanel";
import { Banner } from "@/components/Banner";

export const metadata = {
  title: "Devices · SC2 Tools",
};

export default function DevicesPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Devices</h1>
        <p className="text-text-muted">
          Pair the SC2 Tools Agent installed on your gaming PC. Your
          replays will start syncing automatically.
        </p>
      </header>
      <Banner variant="divider" />
      <DevicesPanel />
    </div>
  );
}

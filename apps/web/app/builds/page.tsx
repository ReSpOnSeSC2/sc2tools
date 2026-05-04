import { BuildsPanel } from "@/components/BuildsPanel";
import { Banner } from "@/components/Banner";

export const metadata = {
  title: "Builds · SC2 Tools",
};

export default function BuildsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Custom builds</h1>
        <p className="text-text-muted">
          Build orders you author yourself. Mark a build public to
          publish it to the community library.
        </p>
      </header>
      <Banner variant="divider" />
      <BuildsPanel />
    </div>
  );
}

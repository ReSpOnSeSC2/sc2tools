import { OptimizerClient } from "@/components/optimizer/OptimizerClient";

export const metadata = {
  alternates: { canonical: "/optimizer" },
  title: "Build order optimizer · SC2 Tools",
  description:
    "Find the safest StarCraft II opening for the current balance patch — simulate your economy, defend what you scout, and export the build to your library.",
};

export default function OptimizerPage() {
  return (
    <div className="space-y-6">
      <OptimizerClient />
    </div>
  );
}

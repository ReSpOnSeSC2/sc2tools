import { OptimizerClient } from "@/components/optimizer/OptimizerClient";

export const metadata = {
  alternates: { canonical: "/optimizer" },
  title: "Build adapter · SC2 Tools",
  description:
    "Re-time any StarCraft II build between the 12-worker and 8-worker economies — pick one of your games, upload a replay, or use a saved build: same buildings, same order, new timings.",
};

export default function OptimizerPage() {
  return (
    <div className="space-y-6">
      <OptimizerClient />
    </div>
  );
}

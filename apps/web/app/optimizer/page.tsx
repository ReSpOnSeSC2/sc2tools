import { OptimizerClient } from "@/components/optimizer/OptimizerClient";

export const metadata = {
  alternates: { canonical: "/optimizer" },
  title: "Build adapter · SC2 Tools",
  description:
    "Re-time your proven StarCraft II build orders for the current balance patch — same buildings, same order, new timings, with a safety check against what you scout.",
};

export default function OptimizerPage() {
  return (
    <div className="space-y-6">
      <OptimizerClient />
    </div>
  );
}

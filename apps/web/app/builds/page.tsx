import { BuildsLibrary } from "@/components/builds/BuildsLibrary";

export const metadata = {
  title: "Custom builds · SC2 Tools",
  description:
    "Your private library of StarCraft II openers — synced across devices, optionally shared with the community.",
};

export default function BuildsPage() {
  return (
    <div className="space-y-6">
      <BuildsLibrary />
    </div>
  );
}

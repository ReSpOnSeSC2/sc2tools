import type { Metadata } from "next";
import { SharedReplayVerdict } from "@/components/balance/SharedReplayVerdict";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const dynamic = "force-static";

export const metadata: Metadata = {
  ...pageMetadata({ title: "Balance Court verdict", description: "An anonymous StarCraft II ladder balance verdict with matchup evidence from SC2Pulse.", canonical: "/balance/verdict", routeOgImage: true }),
  robots: { index: false, follow: true },
};

export default function BalanceVerdictPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="font-display text-h1 text-text">Balance Court verdict</h1>
      <SharedReplayVerdict />
    </div>
  );
}

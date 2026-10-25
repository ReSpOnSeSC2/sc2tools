import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { getInstantImportMode } from "@/lib/instant/flag";

/**
 * GetYourOwnCTA — the viral-loop conversion surface on a shared player
 * page. A visitor who landed here from someone's Season Recap / battle
 * card sees a branded "get your own — sc2tools.com" call to action.
 *
 * Server-component-safe (no hooks). Links to the marketing root so a
 * signed-out visitor starts the sign-in → install-agent flow rather than
 * being bounced by the protected-route middleware.
 */
export function GetYourOwnCTA() {
  const instant = getInstantImportMode() === "all";
  return (
    <Card variant="feature" padded={false} className="relative overflow-hidden">
      <GlowHalo color="mixed" position="bottom-right" />
      <div className="relative flex flex-col items-start gap-4 px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="space-y-1">
          <p className="overline text-accent-cyan">Free · no card required</p>
          <h2 className="text-h3 font-bold text-text">
            {instant ? "Analyze your replays free" : "Track your own StarCraft II stats"}
          </h2>
          <p className="max-w-md text-body text-text-muted">
            {instant ? "Get a private replay report in your browser, with no download or account." : "Sign in, install the agent, and your opponents, build orders, and match history load in seconds — on every device."}
          </p>
        </div>
        <Link
          href={instant ? "/try?utm_source=player&utm_medium=link&utm_campaign=instant" : "/"}
          className="hard-press inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border-2 border-line bg-accent px-5 font-display text-body font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {instant ? "Analyze your replays free" : "Get yours at sc2tools.com"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}

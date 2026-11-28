import Link from "next/link";
import { LadderVods } from "@/components/ladder/LadderVods";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const dynamic = "force-static";
export const metadata = pageMetadata({
  title: "Ladder VODs",
  description: "Find recent StarCraft II ladder games with a Twitch VOD that opens at the game. Pick a matchup, rating, game length and map.",
  canonical: "/ladder-vods",
});

const LINK = "inline-flex min-h-11 items-center rounded-sm text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

export default function LadderVodsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-8">
      <header className="space-y-1">
        <Link href="/tools" className={LINK}>All tools</Link>
        <h1 className="font-display text-3xl font-bold leading-tight text-text sm:text-display-lg">Ladder VODs</h1>
        <p className="max-w-prose text-body text-text-muted">Recent ladder games that a streamer recorded. Pick a matchup, a rating, a length or a map, and each result opens the Twitch VOD at the start of the game.</p>
      </header>
      <LadderVods />
      <p className="max-w-prose text-caption text-text-muted">Games and VOD links come from SC2Pulse through SC2 Tools and are kept for a few minutes. Ratings are rounded to the nearest 100, and only the streamer&apos;s channel is shown, never the other player.</p>
    </div>
  );
}

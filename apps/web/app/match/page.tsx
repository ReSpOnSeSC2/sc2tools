import Link from "next/link";
import { MatchCreate } from "@/components/match/MatchCreate";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const metadata = pageMetadata({
  title: "StarCraft II Match Rooms",
  description: "Run a best-of series with a shared map veto, a turn timer and a score. Players and spectators join by link.",
  canonical: "/match",
});

export default function MatchPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <header className="space-y-2">
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">Match Rooms</h1>
        <p className="max-w-prose text-body text-text-muted">
          Run a StarCraft II map veto and keep score. Share a seat link with each player and a watch link with spectators.
        </p>
      </header>
      <MatchCreate />
      <Link href="/help/match-rooms" className="inline-flex min-h-11 items-center text-caption font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
        How Match Rooms work
      </Link>
    </div>
  );
}

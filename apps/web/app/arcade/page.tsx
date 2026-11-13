import Link from "next/link";
import { DailyArcade } from "@/components/daily/DailyArcade";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const metadata = pageMetadata({
  title: "SC2 Daily",
  description: "Call the trade in five StarCraft II fights. Watch the result and keep a daily streak on this device.",
  canonical: "/arcade",
});

export default function ArcadePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <header className="space-y-2">
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">SC2 Daily</h1>
        <p className="max-w-prose text-body text-text-muted">
          Five StarCraft II fights. Pick which side trades better, then watch it play out.
        </p>
      </header>
      <Link href="/arcade/scout" prefetch={false} className="block rounded-xl border border-line bg-bg-surface p-4 focus-visible:ring-2 focus-visible:ring-accent">
        <span className="block font-semibold text-accent underline">Play Daily Scout</span>
        <span className="text-body text-text-muted">Identify the opening from building locations and timings.</span>
      </Link>
      <DailyArcade />
      <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-2 text-caption">
        <Link href="/help/sc2-daily" prefetch={false} className="inline-flex min-h-11 items-center font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
          How SC2 Daily works
        </Link>
        <Link href="/app/arcade" prefetch={false} className="inline-flex min-h-11 items-center font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
          Play the 18 personal Arcade modes
        </Link>
      </footer>
    </div>
  );
}

import Link from "next/link";
import { DailyScout } from "@/components/daily/DailyScout";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const metadata = pageMetadata({
  title: "Daily Scout",
  description: "Read building placements and timings to identify five StarCraft II openings. A new set each UTC day.",
  canonical: "/arcade/scout",
});

export default function DailyScoutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <header className="space-y-2">
        <Link href="/arcade" prefetch={false} className="inline-flex min-h-11 items-center rounded font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
          Back to SC2 Daily
        </Link>
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">Daily Scout</h1>
        <p className="max-w-prose text-body text-text-muted">
          Use building locations and timings to identify five StarCraft II openings. A new set starts at midnight UTC.
        </p>
      </header>
      <DailyScout />
      <footer className="border-t border-line pt-2 text-caption">
        <Link href="/help/sc2-daily#scout" prefetch={false} className="inline-flex min-h-11 items-center rounded font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
          How to play Daily Scout
        </Link>
      </footer>
    </div>
  );
}

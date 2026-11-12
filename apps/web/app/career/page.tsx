import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Career } from "@/components/career/Career";
import { getInstantImportMode } from "@/lib/instant/flag";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const TITLE = "Your StarCraft II career";
const DESCRIPTION = "See your ladder history from the replay files you choose. Your replays stay in this browser.";

export const metadata: Metadata = getInstantImportMode() === "all"
  ? pageMetadata({ title: TITLE, description: DESCRIPTION, canonical: "/career" })
  : {};

export default function CareerPage() {
  if (getInstantImportMode() !== "all") notFound();
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-3">
        <Link href="/" prefetch={false} className="inline-flex min-h-11 items-center rounded-md font-display font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">SC2 Tools</Link>
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">{TITLE}</h1>
        <p className="max-w-prose text-body text-text-muted">{DESCRIPTION} No account needed.</p>
      </header>
      <Career />
      <aside className="max-w-prose space-y-2 text-caption text-text-muted">
        <p>The browser checks up to 50,000 files. Choose the same folder again to include new replays and reuse saved headers for unchanged files.</p>
        <Link href="/help/replay-career" prefetch={false} className="inline-flex min-h-11 items-center rounded-md font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">How your replay record works</Link>
      </aside>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { YearRecap } from "@/components/wrapped/YearRecap";
import { getInstantImportMode } from "@/lib/instant/flag";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const TITLE = "Your 2026 in StarCraft II";
const DESCRIPTION = "Make a year recap from your 2026 ladder replays. Your files stay on this device.";

export const metadata: Metadata = getInstantImportMode() === "all"
  ? pageMetadata({ title: TITLE, description: DESCRIPTION, canonical: "/wrapped", routeOgImage: true })
  : {};

export default function YearRecapPage() {
  if (getInstantImportMode() !== "all") notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-3">
        <Link href="/" prefetch={false} className="inline-flex min-h-11 items-center rounded-md font-display font-bold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          SC2 Tools
        </Link>
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">{TITLE}</h1>
        <p className="max-w-prose text-body text-text-muted">{DESCRIPTION} No account needed.</p>
      </header>
      <YearRecap />
      <aside className="max-w-prose space-y-2 text-caption text-text-muted">
        <p>The recap checks up to 50,000 replay files. It reads files last modified in 2026 and counts one-versus-one ladder games dated in 2026 (UTC). Games resumed from a replay can be included.</p>
        <Link className="inline-flex min-h-11 items-center rounded-md font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          href="/help/year-in-review" prefetch={false}>How the recap works</Link>
        <Link className="inline-flex min-h-11 items-center rounded-md font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          href="/career" prefetch={false}>View your replay record across years</Link>
      </aside>
    </div>
  );
}

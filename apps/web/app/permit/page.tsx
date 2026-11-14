import Link from "next/link";
import { WhinePermit } from "@/components/balance/WhinePermit";
import { SC2PULSE_URL } from "@/lib/balance/evidence";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const dynamic = "force-static";
export const metadata = pageMetadata({
  title: "StarCraft II Whine Permit",
  description: "Compare your StarCraft II matchup record with the ladder at your rank. Your record stays on your device.",
  canonical: "/permit",
});

const LINK = "inline-flex min-h-11 items-center rounded-sm text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

export default function PermitPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-8">
      <header className="space-y-2">
        <Link href="/balance" className={LINK}>Ladder Balance</Link>
        <h1 className="font-display text-display-lg font-bold text-text">Whine Permit</h1>
        <p className="max-w-prose text-body text-text-muted">Enter your wins and losses to compare your record with same-tier ladder games. Your record stays in this tab unless you choose to download a card.</p>
        <p className="text-caption text-text-muted">Data from the <a href={SC2PULSE_URL} className={LINK}>SC2Pulse API</a>.</p>
      </header>
      <WhinePermit />
      <p className="max-w-prose text-body text-text-muted">The permit compares gaps below 50%. The ladder can account for up to its own observed gap. The rest is the gap between your record and that benchmark. The comparison cannot establish what caused a loss.</p>
      <Link href="/try#balance-court" className={LINK}>Analyze a loss in Balance Court</Link>
    </div>
  );
}

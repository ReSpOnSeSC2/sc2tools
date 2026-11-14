import Link from "next/link";
import { LadderBalance } from "@/components/balance/LadderBalance";
import { LinkButton } from "@/components/ui/Button";
import { BALANCE_LEAGUES, BALANCE_MATCHUPS, BALANCE_RACES, LEAGUE_NAMES } from "@/lib/balance/bundle";
import { getInstantImportMode } from "@/lib/instant/flag";
import { pageMetadata } from "@/lib/seo/pageMetadata";

export const dynamic = "force-static";

export const metadata = pageMetadata({
  title: "StarCraft II Ladder Balance",
  description: "Compare StarCraft II ladder matchup win rates by league tier, with sample sizes and Wilson intervals. Data from SC2Pulse.",
  canonical: "/balance",
});

const SOURCE = "https://sc2pulse.nephest.com/sc2/";
const LINK_CLASS = "inline-flex min-h-11 items-center rounded-sm font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent";

export default function BalancePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-8">
      <header className="space-y-2">
        <Link href="/" prefetch={false} className={LINK_CLASS}>SC2 Tools home</Link>
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">Ladder Balance</h1>
        <p className="max-w-prose text-body text-text-muted">
          Compare StarCraft II ranked 1v1 win rates for Protoss, Terran, and Zerg by league tier.
        </p>
        <p className="text-caption text-text-muted">Data from the <a href={SOURCE} className={LINK_CLASS}>SC2Pulse API</a>.</p>
      </header>
      <nav aria-label="Balance tools" className="flex flex-wrap gap-2">
        <LinkButton href="/balance/claim" size="lg" prefetch={false}>Build a claim</LinkButton>
        <LinkButton href="/permit" size="lg" variant="secondary" prefetch={false}>Whine Permit</LinkButton>
        {getInstantImportMode() === "all" && <LinkButton href="/try#balance-court" size="lg" variant="secondary" prefetch={false}>Replay verdict</LinkButton>}
      </nav>
      <LadderBalance />
      <nav aria-label="Balance by matchup and league" className="space-y-2 rounded-xl border border-line bg-bg-surface p-4">
        <h2 className="font-display text-h2 font-bold text-text">Matchups and leagues</h2>
        <ul className="flex flex-wrap gap-x-4">
          {BALANCE_MATCHUPS.map(matchup => <li key={matchup}><Link className={LINK_CLASS} href={`/balance/${matchup.toLowerCase()}`} prefetch={false}>{BALANCE_RACES[matchup].join(" vs ")}</Link></li>)}
        </ul>
        <ul className="flex flex-wrap gap-x-4">
          {BALANCE_LEAGUES.map(league => <li key={league}><Link className={LINK_CLASS} href={`/balance/league/${league}`} prefetch={false}>{LEAGUE_NAMES[league]}</Link></li>)}
        </ul>
      </nav>
      <noscript><p className="text-body text-text-muted">Enable JavaScript to load the latest ladder balance snapshot.</p></noscript>
      <section className="space-y-2 rounded-xl border border-line bg-bg-surface p-4" aria-labelledby="balance-methods">
        <h2 id="balance-methods" className="font-display text-h2 font-bold text-text">How to read these numbers</h2>
        <ul className="max-w-prose list-disc space-y-2 pl-5 text-body text-text-muted">
          <li>SC2Pulse tracks a subset of ranked 1v1 ladder games in the Americas, Europe, and Korea. It groups players by their inferred favorite race, and Random is excluded here.</li>
          <li>We pool game counts across the three regions and show the win rate for the first named race. The 95% Wilson interval describes uncertainty in the observed sample.</li>
          <li>The main figures use same-tier games. Cross-tier games appear separately and can count in both players’ tiers, so their counts cannot be added across tiers.</li>
          <li>Totals include tracked games with unknown duration. SC2Pulse leaves out the first eight days of a season while league rankings settle. The snapshot date shows when SC2 Tools collected the counts.</li>
        </ul>
      </section>
    </div>
  );
}

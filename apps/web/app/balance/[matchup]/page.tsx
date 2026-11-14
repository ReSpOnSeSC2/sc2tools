import { notFound } from "next/navigation";
import { BALANCE_MATCHUPS } from "@/lib/balance/bundle";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { BalanceEvidencePage } from "@/components/balance/receipts/BalanceEvidencePage";
import { EvidenceBreakdown } from "@/components/balance/receipts/EvidenceBreakdown";
import { matchupTitle, parseMatchup } from "@/components/balance/receipts/selection";

type Props = { params: Promise<{ matchup: string }> };

export const dynamicParams = false;
export const dynamic = "force-static";

export function generateStaticParams() {
  return BALANCE_MATCHUPS.map(matchup => ({ matchup: matchup.toLowerCase() }));
}

function context(slug: string) {
  const matchup = parseMatchup(slug);
  if (!matchup) notFound();
  const name = matchupTitle(matchup);
  return { matchup, title: `${name} Ladder Balance`, description: `Compare ${name} win rates, sample sizes, and Wilson intervals by league and tier in StarCraft II.` };
}

export async function generateMetadata({ params }: Props) {
  const { matchup } = await params;
  const { title, description } = context(matchup);
  return pageMetadata({ title, description, canonical: `/balance/${matchup}` });
}

export default async function MatchupPage({ params }: Props) {
  const { matchup: slug } = await params;
  const { matchup, title, description } = context(slug);
  return (
    <BalanceEvidencePage title={title} description={description}>
      <EvidenceBreakdown scope={{ matchup }} />
    </BalanceEvidencePage>
  );
}

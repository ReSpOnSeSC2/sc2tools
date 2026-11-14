import { notFound } from "next/navigation";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { BalanceEvidencePage } from "@/components/balance/receipts/BalanceEvidencePage";
import { EvidenceBreakdown } from "@/components/balance/receipts/EvidenceBreakdown";
import { BALANCE_COHORT_OPTIONS } from "@/lib/balance/evidence";

type Props = { params: Promise<{ tier: string }> };

export const dynamicParams = false;
export const dynamic = "force-static";

export function generateStaticParams() {
  return BALANCE_COHORT_OPTIONS.map(option => ({ tier: option.value }));
}

function context(tier: string) {
  const cohort = BALANCE_COHORT_OPTIONS.find(option => option.value === tier);
  if (!cohort) notFound();
  const name = cohort.label;
  return { title: `${name} Ladder Balance`, description: `See ${name} win rates, sample sizes, and Wilson intervals for the three ranked StarCraft II matchups between races.` };
}

export async function generateMetadata({ params }: Props) {
  const { tier } = await params;
  return pageMetadata({ ...context(tier), canonical: `/balance/league/${tier}` });
}

export default async function LeaguePage({ params }: Props) {
  const { tier } = await params;
  return (
    <BalanceEvidencePage {...context(tier)}>
      <EvidenceBreakdown scope={{ cohort: tier }} />
    </BalanceEvidencePage>
  );
}

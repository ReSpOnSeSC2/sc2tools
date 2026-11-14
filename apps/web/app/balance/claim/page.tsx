import { BalanceEvidencePage } from "@/components/balance/receipts/BalanceEvidencePage";
import { ClaimBuilder } from "@/components/balance/receipts/ClaimBuilder";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const TITLE = "Balance Receipts";
const DESCRIPTION = "Check a StarCraft II ladder balance claim, then share the result with its sample size, confidence interval, and pinned snapshot.";

export const dynamic = "force-static";
export const metadata = pageMetadata({ title: TITLE, description: DESCRIPTION, canonical: "/balance/claim" });

export default function ClaimPage() {
  return (
    <BalanceEvidencePage title={TITLE} description={DESCRIPTION}>
      <ClaimBuilder />
    </BalanceEvidencePage>
  );
}

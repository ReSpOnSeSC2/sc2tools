import { currentCoverage, type CoverageMonth } from "@/lib/donationCoverage";
import { getJson } from "@/lib/serverApi";

export async function getDonationCoverage(goalUsd: number) {
  const data = await getJson<{ coverage: CoverageMonth | null }>("/v1/public/donations/current", { revalidateSec: 600 });
  return currentCoverage(data?.coverage, goalUsd);
}

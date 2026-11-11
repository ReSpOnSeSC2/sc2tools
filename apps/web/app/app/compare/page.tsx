import { CompareGamesPage } from "@/components/analyzer/compare/CompareGamesPage";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { compareHref, compareReferenceRequest, COMPARE_REFERENCES_PATH, isLegacyCompareGameId, type CompareReferences } from "@/lib/compareGameLinks";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";

export const metadata = { title: "Compare games", description: "Two of your games side by side: timelines, build-order diff and mechanics." };

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Comparison links remain usable within the signed-in owner's account. */
export default async function CompareRoute({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const values = [first(query.a), first(query.b)];
  const canonical = values.map(value => isPublicReplayReference(value) ? value : null);
  const legacy = values.filter((value): value is string => isLegacyCompareGameId(value) && !isPublicReplayReference(value));
  if (legacy.length) {
    const result = await apiFetch<CompareReferences>(COMPARE_REFERENCES_PATH, compareReferenceRequest(legacy));
    if (!result.ok && (result.status === 0 || result.status === 429 || result.status >= 500)) {
      throw new Error("Couldn't open this legacy comparison. Try again.");
    }
    const [a, b] = canonical.map((reference, index) => reference ??
      (result.ok ? result.data.references[legacy.indexOf(values[index] ?? "")] ?? null : null));
    redirect(compareHref(a, b));
  }
  if (values.some((value, index) => value !== undefined && !canonical[index])) {
    redirect(compareHref(canonical[0], canonical[1]));
  }
  return <CompareGamesPage a={canonical[0]} b={canonical[1]} />;
}

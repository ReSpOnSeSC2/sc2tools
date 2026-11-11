import { CompareGamesPage } from "@/components/analyzer/compare/CompareGamesPage";
import { isCompareGameId } from "@/lib/gameCompare";

export const metadata = { title: "Compare games", description: "Two of your games side by side: timelines, build-order diff and mechanics." };

type Query = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** /app/compare?a=&b= — shareable within your account; ids are validated, never trusted. */
export default async function CompareRoute({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const a = first(query.a), b = first(query.b);
  return <CompareGamesPage a={isCompareGameId(a) ? a : null} b={isCompareGameId(b) ? b : null} />;
}

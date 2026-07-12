import { GameDetailPage } from "@/components/analyzer/game/GameDetailPage";
import { opponentContextFromQuery } from "@/lib/opponentNavigation";

/**
 * /app/game/[gameId] — per-replay deep dive. Opponent-profile entry points
 * carry their source in the query so refreshes and copied URLs retain the
 * correct backlink; ordinary game URLs keep the dashboard fallback.
 */
export default async function GameDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [route, query] = await Promise.all([params, searchParams]);
  return (
    <GameDetailPage
      gameId={safeDecode(route.gameId || "")}
      opponentContext={opponentContextFromQuery(query)}
    />
  );
}

/** Row links encode the id; decode defensively (older links may not). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

import type { Metadata } from "next";
import { GameDetailPage } from "@/components/analyzer/game/GameDetailPage";
import { gameTitle } from "@/components/analyzer/game/gameTitle";
import type { GameSummary } from "@/components/analyzer/game/types";
import { apiFetch } from "@/lib/api";
import { newBuildSideFromQuery } from "@/lib/buildIntentLinks";
import { opponentContextFromQuery } from "@/lib/opponentNavigation";
import { replayTimeFromQuery } from "@/lib/replayLink";

/**
 * Longest the title lookup may take. Metadata streams separately from
 * the page, but a Render cold start should still not hold it for long:
 * past this the tab just says "Game details".
 */
const TITLE_LOOKUP_TIMEOUT_MS = 2500;

/**
 * Tab title from the game's slim summary row (the same small record the
 * page header loads): "Defeat · PvZ on Alcyone LE".
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ gameId: string }>;
}): Promise<Metadata> {
  const { gameId } = await params;
  const id = safeDecode(gameId || "");
  if (!id) return { title: "Game details" };
  const res = await apiFetch<GameSummary>(`/v1/games/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(TITLE_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) return { title: res.status === 404 ? "Game not found" : "Game details" };
  return { title: gameTitle(res.data) ?? "Game details" };
}

/**
 * /app/game/[gameId] — per-replay deep dive. Opponent-profile entry points
 * carry their source in the query so refreshes and copied URLs retain the
 * correct backlink; ordinary game URLs keep the dashboard fallback.
 * `?newBuild=you|opponent` (the desktop app's "Add new build…") opens the
 * build editor from the game's check-in once, then leaves the URL.
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
      initialTimeSec={replayTimeFromQuery(query)}
      initialNewBuild={newBuildSideFromQuery(query)}
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

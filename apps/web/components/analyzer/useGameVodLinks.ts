"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import type { OpponentNavigationContext } from "@/lib/opponentNavigation";
import type { ProfileGame } from "./Last5GamesTimeline";
import type { GameVodLinksResponse } from "./GameStreamLinks";

/**
 * Resolve stream links for exactly the games visible in a table. The range
 * request is retained as a compatibility fallback during the POST rollout.
 */
export function useGameVodLinks(
  games: readonly ProfileGame[],
  opponentContext?: OpponentNavigationContext | null,
): GameVodLinksResponse | null {
  const { getToken, isLoaded: authLoaded, isSignedIn } = useAuth();
  const [data, setData] = useState<GameVodLinksResponse | null>(null);
  const rangePath = useMemo(
    () => gameVodLinksRangePath(games, opponentContext),
    [games, opponentContext],
  );
  const gameIds = useMemo(
    () =>
      Array.from(
        new Set(
          games
            .map((game) =>
              typeof game.id === "string" ? game.id.trim() : "",
            )
            .filter((id) => id.length > 0 && id.length <= 200),
        ),
      ).slice(0, 1000),
    [games],
  );
  const includeOpponent = !!opponentContext?.pulseId?.trim();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    if (!authLoaded || !isSignedIn || gameIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      try {
        const next = await apiCall<GameVodLinksResponse>(
          getToken,
          "/v1/games/vod-links",
          {
            method: "POST",
            body: JSON.stringify({ gameIds, includeOpponent }),
          },
        );
        if (!cancelled) setData(next);
      } catch (error) {
        // Stream enrichment is optional. Fall back to the original range GET
        // only when the POST route itself is absent during a rolling deploy.
        // Retrying auth/provider/network failures with a broad range request
        // would duplicate work and may scan games that are not on screen.
        const status = (error as { status?: unknown })?.status;
        if (status !== 404 && status !== 405) return;
        if (!rangePath) return;
        try {
          const next = await apiCall<GameVodLinksResponse>(getToken, rangePath);
          if (!cancelled) setData(next);
        } catch {
          // No error UI for optional stream enrichment.
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    authLoaded,
    gameIds,
    getToken,
    includeOpponent,
    isSignedIn,
    rangePath,
  ]);

  return data;
}

function gameVodLinksRangePath(
  games: readonly ProfileGame[],
  opponentContext?: OpponentNavigationContext | null,
): string | null {
  let sinceMs = Number.POSITIVE_INFINITY;
  let untilMs = Number.NEGATIVE_INFINITY;
  for (const game of games) {
    if (!game.date) continue;
    const at = new Date(game.date).getTime();
    if (!Number.isFinite(at)) continue;
    sinceMs = Math.min(sinceMs, at);
    untilMs = Math.max(untilMs, at);
  }
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return null;

  const query = new URLSearchParams({
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
  });
  const opponentPulseId = opponentContext?.pulseId?.trim();
  if (opponentPulseId) {
    query.set("includeOpponent", "1");
    query.set("oppPulseId", opponentPulseId);
  }
  return `/v1/games/vod-links?${query.toString()}`;
}

import { cache } from "react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";

export interface PublicReplayCard {
  profile: { handle: string; displayName: string };
  game: {
    result: string | null;
    matchup: string | null;
    map: string | null;
    durationSec: number | null;
    myBuild: string | null;
    oppStrategy: string | null;
    date: string | null;
    replayAvailable: boolean;
  };
}

export const readPublicReplayCard = cache(async (player: string, reference: string) => {
  if (!isPublicReplayReference(reference)) return { data: null, status: 404 };
  return getJsonWithStatus<PublicReplayCard>("/v1/public/replays/" + encodeURIComponent(player) + "/" + reference + "/card", {
    revalidateSec: 0, signal: AbortSignal.timeout(8000),
  });
});

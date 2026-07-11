"use client";

import { useParams } from "next/navigation";
import { GameDetailPage } from "@/components/analyzer/game/GameDetailPage";

/**
 * /app/game/[gameId] — per-replay deep dive. Client-fetch pattern like
 * the rest of the authed app (the /app segment is Clerk-protected in
 * middleware.ts); all data loads via useApi inside GameDetailPage.
 */
export default function GameDetailRoute() {
  const params = useParams<{ gameId: string }>();
  const raw = params?.gameId;
  const segment = Array.isArray(raw) ? raw[0] : raw || "";
  return <GameDetailPage gameId={safeDecode(segment)} />;
}

/** Row links encode the id; decode defensively (older links may not). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

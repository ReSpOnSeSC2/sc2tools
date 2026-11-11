import { cache } from "react";
import { getJsonWithStatus } from "@/lib/serverApi";
import type { PublicStreamReport } from "@/lib/reports";

export type PublicStreamParams = { params: Promise<{ player: string; id: string }> };

export const fetchPublicStreamReport = cache(async (player: string, id: string) => {
  if (!/^[a-z0-9-]{1,64}$/.test(player) || !/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  const result = await getJsonWithStatus<PublicStreamReport>(`/v1/public/players/${encodeURIComponent(player)}/streams/${encodeURIComponent(id)}`);
  return result.data;
});

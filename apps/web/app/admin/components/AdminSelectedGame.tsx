"use client";
import { useApi } from "@/lib/clientApi";
import { RequestError } from "@/components/ui/RequestError";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AdminGameDetail, type AdminGameDetailGame } from "./AdminGameDetail";

/** Off-page links use existing owner-scoped detail endpoints, never guessed owners. */
export function AdminSelectedGame({ userId, gameId, row, onClear }: { userId: string; gameId: string; row?: AdminGameDetailGame; onClear: () => void }) {
  const probe = useApi<{ my_race?: string; opp_race?: string }>(!row && userId ? `/v1/admin/users/${encodeURIComponent(userId)}/games/${encodeURIComponent(gameId)}/build-order` : null, { revalidateOnFocus: false });
  if (!userId || probe.error?.code === "game_not_found") return <Card padded><h3 className="text-h3">Game not found</h3><p className="text-caption">The owner and game must identify a saved replay.</p><Button variant="secondary" onClick={onClear}>Clear selection</Button></Card>;
  if (probe.error) return <RequestError error={probe.error} onRetry={() => probe.mutate()} />;
  if (!row && !probe.data) return <p role="status">Loading selected game…</p>;
  const game: AdminGameDetailGame = row || { gameId, date: null, result: null, myRace: probe.data?.my_race || null, map: null, durationSec: null, myMmr: null, macroScore: null, opponent: { displayName: "", race: probe.data?.opp_race || "U", mmr: null } };
  return <div className="space-y-3">{!row ? <p role="note" className="text-caption text-text-muted">This game isn’t on the current page.</p> : null}<AdminGameDetail userId={userId} game={game} onBack={onClear} /></div>;
}

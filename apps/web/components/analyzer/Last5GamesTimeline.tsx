"use client";

import { EmptyState } from "@/components/ui/Card";
import { fmtDate, fmtMinutes } from "@/lib/format";

export type ProfileGame = {
  id?: string | null;
  date?: string | null;
  result?: string | null;
  map?: string | null;
  opp_strategy?: string | null;
  my_build?: string | null;
  game_length?: number | null;
};

/**
 * Last-5-games timeline shown beside the median-timings card. One
 * row per game with map, length, opponent strategy, and the user's
 * build. Win/loss tinted by result.
 */
export function Last5GamesTimeline({ games }: { games?: ProfileGame[] }) {
  if (!games || games.length === 0) {
    return <EmptyState sub="No recent games" />;
  }
  return (
    <div className="space-y-2">
      {games.map((g, i) => {
        const result = g.result || "";
        const isWin = result === "Win" || result === "Victory";
        const isLoss = result === "Loss" || result === "Defeat";
        const colour = isWin ? "#3ec07a" : isLoss ? "#ff6b6b" : "#9aa3b2";
        const len = g.game_length || 0;
        const lenStr = len ? ` (${fmtMinutes(len)})` : "";
        return (
          <div
            key={g.id || i}
            className="rounded-lg border border-border bg-bg-elevated px-3 py-2"
            data-testid="last5-row"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: colour }}>
                {fmtDate(g.date)} · {result || "—"}
                {lenStr}
              </span>
              <span
                className="ml-3 max-w-[40%] truncate text-xs text-text-dim"
                title={g.map || ""}
              >
                {g.map || "—"}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-text-muted">
              opp:{" "}
              <span className="text-text">{g.opp_strategy || "—"}</span>
            </div>
            <div className="mt-0.5 text-xs text-text-muted">
              me: <span className="text-text">{g.my_build || "—"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Trophy } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { weekKey as computeWeekKey } from "@/components/analyzer/arcade/ArcadeEngine";

interface ApiRow {
  rank: number;
  displayName: string;
  pnlPct: number;
  isAnonymous: boolean;
}
interface ApiResp {
  weekKey: string;
  items: ApiRow[];
}

/**
 * LeaderboardTab — Stock Market weekly P&L. Opt-in display, anonymised
 * by default. Privacy: rows show display name (or "Anonymous N"),
 * weekly P&L %, and rank — NEVER the underlying portfolio.
 */
export function LeaderboardTab() {
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [wk, setWk] = useState<string>(() => computeWeekKey(new Date(), tz));
  const { data, isLoading, error } = useApi<ApiResp>(
    `/v1/arcade/leaderboard?weekKey=${encodeURIComponent(wk)}`,
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Trophy className="h-5 w-5 text-warning" aria-hidden />
          <div className="flex-1">
            <h2 className="text-body font-semibold text-text">Stock Market — Weekly P&amp;L</h2>
            <p className="text-caption text-text-muted">
              Players who opted into the public leaderboard. Rows show rank, display name (or
              anonymous handle), and weekly P&amp;L %. Portfolios stay private.
            </p>
          </div>
          <label className="text-caption text-text-muted">
            Week
            <input
              type="text"
              value={wk}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d{4}-W\d{2}$/.test(v)) setWk(v);
              }}
              aria-label="ISO week key (e.g. 2026-W19)"
              className="ml-2 h-9 w-28 rounded border border-border bg-bg-elevated px-2 font-mono text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
        </div>
      </Card>

      {isLoading ? (
        <Skeleton rows={6} />
      ) : error ? (
        <Card>
          <EmptyState
            title="Couldn't load leaderboard"
            sub={error.message || "Try again in a moment."}
          />
        </Card>
      ) : !data?.items?.length ? (
        <Card>
          <EmptyState
            title="No entries yet for this week"
            sub="Lock a Stock Market portfolio in Arcade and opt into the leaderboard to appear here."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <table className="w-full text-caption">
            <thead className="border-b border-border bg-bg-elevated text-left text-text-dim">
              <tr>
                <th className="px-3 py-2">Rank</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2 text-right">Weekly P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={`${r.rank}-${r.displayName}`} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono tabular-nums text-text">#{r.rank}</td>
                  <td className="px-3 py-2 text-text">
                    {r.displayName}
                    {r.isAnonymous ? (
                      <span className="ml-1 text-text-dim">(anonymous)</span>
                    ) : null}
                  </td>
                  <td
                    className={[
                      "px-3 py-2 text-right font-mono tabular-nums",
                      r.pnlPct > 0 ? "text-success" : r.pnlPct < 0 ? "text-danger" : "text-text-dim",
                    ].join(" ")}
                  >
                    {r.pnlPct > 0 ? "+" : ""}
                    {r.pnlPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

"use client";

import type { CumulativePoint, PeriodPoint } from "@/lib/h2hSeries";
import { fmtDate, fmtMinutes } from "@/lib/format";

/**
 * Recharts custom tooltip renderers shared by the H2H timeline and
 * period-bar sub-charts. They take `active` and `payload` directly
 * from Recharts (typed loosely here because the recharts payload
 * shape changes with the chart kind).
 */

type TooltipPayload<T> = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: T }>;
};

export function CumulativeTooltip({
  active,
  payload,
  rollingLabel,
}: TooltipPayload<CumulativePoint> & { rollingLabel: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const game = point.game;
  return (
    <div
      role="tooltip"
      className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-xs shadow-[var(--shadow-card)]"
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-text-dim">
          #{point.index} · {fmtDate(game.date)}
        </span>
        <span
          className={
            point.isWin
              ? "font-semibold text-success"
              : point.isLoss
                ? "font-semibold text-danger"
                : "font-semibold text-text-muted"
          }
          aria-label={point.isWin ? "Win" : point.isLoss ? "Loss" : "Unknown"}
        >
          {point.isWin ? "▲ Win" : point.isLoss ? "▼ Loss" : "—"}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-text-dim">Map</span>
        <span className="truncate text-text">{game.map || "—"}</span>
        <span className="text-text-dim">My build</span>
        <span className="truncate text-text">{game.my_build || "—"}</span>
        <span className="text-text-dim">Opp strategy</span>
        <span className="truncate text-text">{game.opp_strategy || "—"}</span>
        <span className="text-text-dim">Length</span>
        <span className="text-text">
          {game.game_length ? fmtMinutes(game.game_length) : "—"}
        </span>
        {typeof game.macro_score === "number" ? (
          <>
            <span className="text-text-dim">Macro</span>
            <span className="text-text">{game.macro_score}</span>
          </>
        ) : null}
        <span className="text-text-dim">Cum. WR</span>
        <span className="tabular-nums text-text">
          {point.cumulativeWrPct}% ({point.cumulativeWins}-
          {point.cumulativeLosses})
        </span>
        {point.rollingWrPct != null ? (
          <>
            <span className="text-text-dim">{rollingLabel}</span>
            <span className="tabular-nums text-text">{point.rollingWrPct}%</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function PeriodTooltip({
  active,
  payload,
  bucketLabel,
}: TooltipPayload<PeriodPoint> & { bucketLabel: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div
      role="tooltip"
      className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-xs shadow-[var(--shadow-card)]"
    >
      <div className="mb-1 font-mono text-[11px] text-text-dim">
        {bucketLabel} · {point.date}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-text-dim">Win rate</span>
        <span className="tabular-nums text-text">{point.winRatePct}%</span>
        <span className="text-text-dim">Games</span>
        <span className="tabular-nums text-text">
          {point.wins}-{point.losses} ({point.total})
        </span>
      </div>
    </div>
  );
}

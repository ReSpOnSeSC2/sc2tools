"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { pct1 } from "@/lib/format";

type MatchupRow = {
  race: "P" | "T" | "Z" | "R" | "U";
  netMmr: number;
  avgDelta: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
};

type Response = {
  matchups: MatchupRow[];
  totalGames?: number;
  dropped?: {
    longGap: number;
    outlierSwing: number;
    missingMyMmr?: number;
  };
};

const RACE_META: Record<string, { label: string; color: string }> = {
  P: { label: "vs Protoss", color: "#7c8cff" },
  T: { label: "vs Terran", color: "#ff6b6b" },
  Z: { label: "vs Zerg", color: "#a78bfa" },
  R: { label: "vs Random", color: "#9aa3b2" },
  U: { label: "Unknown", color: "#3a4252" },
};

const COLOR_SUCCESS = "#3ec07a";
const COLOR_DANGER = "#ff6b6b";
const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";

/**
 * Net MMR per matchup.
 *
 * Sums the (next-game MMR − this-game MMR) for every consecutive
 * game pair in the filtered set and attributes the delta to the
 * opponent race of the FIRST game. The API drops pairs where the
 * gap or the delta look bigger than a single ladder game, so the
 * total never picks up MMR drift from games the agent didn't tag
 * with myMmr (the bug that briefly let "100% WR vs Protoss" read
 * as a net-negative). Surfaces matchups that are net-positive vs
 * net-negative for your ladder rating — sometimes a >50% WR
 * bleeds MMR because the matchmaker keeps queueing you into
 * lower-rated opponents.
 *
 * Diverging bar layout: zero is the centre, green to the right,
 * red to the left. A footer card per matchup shows games, WR, and
 * average delta so the totals are never read in a vacuum.
 */
export function NetMmrByMatchupChart() {
  const { filters, dbRev } = useFilters();
  const { data, isLoading } = useApi<Response>(
    `/v1/mmr-by-matchup${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    const matchups = (data?.matchups || []).filter((m) => m.games > 0);
    return matchups
      .map((m) => ({
        ...m,
        meta: RACE_META[m.race] || RACE_META.U,
      }))
      .sort((a, b) => b.netMmr - a.netMmr);
  }, [data]);

  const xDomain = useMemo<[number, number]>(() => {
    if (!rows.length) return [-100, 100];
    let mn = 0;
    let mx = 0;
    for (const r of rows) {
      if (r.netMmr < mn) mn = r.netMmr;
      if (r.netMmr > mx) mx = r.netMmr;
    }
    const reach = Math.max(Math.abs(mn), Math.abs(mx), 25);
    const padded = Math.ceil((reach * 1.15) / 10) * 10;
    return [-padded, padded];
  }, [rows]);

  if (isLoading) {
    return (
      <Card title="Net MMR by matchup">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!rows.length) {
    return (
      <Card title="Net MMR by matchup">
        <EmptyState
          title="Not enough MMR-tagged games"
          sub="Once your replays carry MMR, this chart attributes every climb / drop to the matchup that drove it."
        />
      </Card>
    );
  }

  return (
    <Card title="Net MMR by matchup">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        MMR gained (▶) or lost (◀) per opponent race, summed within
        each region from consecutive ranked games. Each pair needs
        your own MMR on both sides, so games the agent didn't tag
        with MMR (older versions) sit out — the line under the
        cards spells out how many. Pairs more than 24 h apart or
        swinging past ±150 MMR (race switches, season resets) are
        dropped so a 100%-WR matchup never reads as a net loss.
      </p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 24, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} horizontal={false} />
            <XAxis
              type="number"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              domain={xDomain}
              tickFormatter={(v: number) => (v > 0 ? `+${v}` : `${v}`)}
            />
            <YAxis
              type="category"
              dataKey="meta.label"
              stroke={COLOR_TEXT_DIM}
              fontSize={12}
              width={104}
              tickMargin={4}
            />
            {/* No Tooltip: the footer cards already show
                netMmr / games / WR / avg-per-game per matchup,
                and on mobile recharts' floating tooltip lands on
                top of the bars when the user taps to read them. */}
            <Bar dataKey="netMmr" radius={[4, 4, 4, 4]} minPointSize={2}>
              {rows.map((r) => (
                <Cell
                  key={r.race}
                  fill={r.netMmr >= 0 ? COLOR_SUCCESS : COLOR_DANGER}
                  fillOpacity={0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map((r) => (
          <div
            key={r.race}
            className="rounded border border-border bg-bg-elevated/50 px-2.5 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="truncate text-[11px] font-semibold"
                style={{ color: r.meta.color }}
              >
                {r.meta.label}
              </span>
              <span
                className="whitespace-nowrap text-sm font-semibold tabular-nums"
                style={{ color: r.netMmr >= 0 ? COLOR_SUCCESS : COLOR_DANGER }}
              >
                {r.netMmr > 0 ? "+" : ""}
                {r.netMmr}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] tabular-nums text-text-dim">
              {r.games} games · {pct1(r.winRate)} WR · avg{" "}
              {r.avgDelta > 0 ? "+" : ""}
              {r.avgDelta}/game
            </div>
          </div>
        ))}
      </div>
      <PairCoverageSummary
        rows={rows}
        totalGames={data?.totalGames}
        dropped={data?.dropped}
      />
    </Card>
  );
}

/**
 * Reconciles the chart's pair count against the user's filtered
 * game count so the disparity isn't mysterious. The Win-Rate-by-MMR
 * chart uses an opponents-collection fallback for opp.mmr, which
 * picks up games where the agent never logged myMmr — those same
 * games can't form Net-MMR pairs (we need myMmr on both sides), so
 * Net-MMR will always read lower. Without surfacing the breakdown
 * the user assumes the chart is broken.
 *
 * Shape: "N pairs from M games · K missing MMR · L long gaps · O outlier swings".
 * Only renders non-zero categories.
 */
function PairCoverageSummary({
  rows,
  totalGames,
  dropped,
}: {
  rows: { games: number }[];
  totalGames: number | undefined;
  dropped:
    | { longGap: number; outlierSwing: number; missingMyMmr?: number }
    | undefined;
}) {
  const pairCount = rows.reduce((sum, r) => sum + r.games, 0);
  const longGap = dropped?.longGap ?? 0;
  const outlierSwing = dropped?.outlierSwing ?? 0;
  const missingMyMmr = dropped?.missingMyMmr ?? 0;
  // Nothing to explain: no totals from API and no drops.
  if (
    !totalGames &&
    !longGap &&
    !outlierSwing &&
    !missingMyMmr
  ) {
    return null;
  }
  const reasons: string[] = [];
  if (missingMyMmr > 0) {
    reasons.push(`${missingMyMmr} missing MMR data`);
  }
  if (longGap > 0) {
    reasons.push(`${longGap} long gap${longGap === 1 ? "" : "s"} (>24 h)`);
  }
  if (outlierSwing > 0) {
    reasons.push(
      `${outlierSwing} outlier swing${outlierSwing === 1 ? "" : "s"} (>±150)`,
    );
  }
  const head =
    typeof totalGames === "number" && totalGames > 0
      ? `${pairCount} pair${pairCount === 1 ? "" : "s"} from ${totalGames} game${totalGames === 1 ? "" : "s"}`
      : `${pairCount} pair${pairCount === 1 ? "" : "s"}`;
  return (
    <p className="mt-2 text-[10px] text-text-dim">
      {head}
      {reasons.length ? ` · ${reasons.join(" · ")}` : ""}
    </p>
  );
}

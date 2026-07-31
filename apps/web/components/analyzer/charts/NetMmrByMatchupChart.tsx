"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
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
import type { NetMmrRace } from "@/lib/netMmrOpponents";
import { NetMmrRaceOpponentsModal } from "./NetMmrRaceOpponentsModal";

type MatchupRow = {
  race: "P" | "T" | "Z" | "R" | "U";
  netMmr: number;
  avgDelta: number;
  pairs?: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
};

type Response = {
  matchups: MatchupRow[];
  totalGames?: number;
  eligibleGames?: number;
  dropped?: {
    outlierSwing?: number;
    missingMyMmr?: number;
    untrustedMyMmr?: number;
    missingIdentity?: number;
    excludedNonRanked1v1?: number;
    terminalGame?: number;
    nextMissingMyMmr?: number;
    nextUntrustedMyMmr?: number;
    signMismatch?: number;
    unsupportedResult?: number;
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

function untrustedMmrMessage(count: number): string {
  const noun = count === 1 ? "value is" : "values are";
  return `${count} historical numeric MMR ${noun} not verified as replay-authored, so excluded. Update the agent, then use Re-sync from scratch.`;
}

/**
 * Net MMR per matchup.
 *
 * Attributes each verified next-MMR delta to the opponent race of the
 * anchor game. Pairing is account-, selected-race-, and queue-aware and
 * happens before display filters so hidden rows cannot be bridged.
 *
 * Diverging bar layout: zero is the centre, green to the right,
 * red to the left. A footer card per matchup shows games, WR, and
 * average delta so the totals are never read in a vacuum.
 */
export function NetMmrByMatchupChart() {
  const { filters, dbRev } = useFilters();
  const [selectedRace, setSelectedRace] = useState<NetMmrRace | null>(null);
  const { data, isLoading } = useApi<Response>(
    `/v1/mmr-by-matchup${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    const matchups = (data?.matchups || [])
      .map((m) => ({ ...m, pairs: m.pairs ?? m.games }))
      .filter((m) => m.pairs > 0);
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
    const untrusted = data?.dropped?.untrustedMyMmr ?? 0;
    const hasFilteredGames = (data?.totalGames ?? 0) > 0;
    return (
      <Card title="Net MMR by matchup">
        <EmptyState
          title={
            untrusted > 0
              ? "Historical MMR needs a replay re-sync"
              : hasFilteredGames
                ? "No verified ranked 1v1 pairs"
                : "Not enough MMR-tagged games"
          }
          sub={
            untrusted > 0
              ? untrustedMmrMessage(untrusted)
              : "This chart needs consecutive ranked 1v1 replays with game-time MMR from both games."
          }
        />
        <PairCoverageSummary
          rows={rows}
          totalGames={data?.totalGames}
          eligibleGames={data?.eligibleGames}
          dropped={data?.dropped}
        />
      </Card>
    );
  }

  return (
    <Card title="Net MMR by matchup">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Game-time MMR gained (▶) or lost (◀) per opponent race. Only
        consecutive, replay-verified ranked 1v1 games on the same account
        and selected ladder race are paired. Missing or unverified MMR
        breaks a pair; impossible result/delta signs and swings past ±150
        are excluded and reported below.
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
          <button
            type="button"
            key={r.race}
            aria-haspopup="dialog"
            aria-expanded={selectedRace === r.race}
            aria-label={`View MMR impact by ${r.meta.label.replace(/^vs /, "")} opponent`}
            onClick={() => setSelectedRace(r.race)}
            className="group rounded border border-border bg-bg-elevated/50 px-2.5 py-2 text-left transition-colors hover:border-accent/60 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="truncate text-micro font-semibold"
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
            <div className="mt-0.5 text-micro tabular-nums text-text-dim">
              {r.pairs} pairs · {pct1(r.winRate)} WR · avg{" "}
              {r.avgDelta > 0 ? "+" : ""}
              {r.avgDelta}/pair
            </div>
            <div className="mt-1.5 flex items-center justify-end gap-0.5 text-micro font-medium text-accent opacity-80 transition-opacity group-hover:opacity-100">
              View opponents
              <ChevronRight aria-hidden className="h-3.5 w-3.5" />
            </div>
          </button>
        ))}
      </div>
      <PairCoverageSummary
        rows={rows}
        totalGames={data?.totalGames}
        eligibleGames={data?.eligibleGames}
        dropped={data?.dropped}
      />
      <NetMmrRaceOpponentsModal
        race={selectedRace}
        onClose={() => setSelectedRace(null)}
      />
    </Card>
  );
}

/**
 * Reconciles pair count against eligible and filtered games, then names
 * every material exclusion instead of silently presenting partial data.
 */
function PairCoverageSummary({
  rows,
  totalGames,
  eligibleGames,
  dropped,
}: {
  rows: { pairs: number }[];
  totalGames: number | undefined;
  eligibleGames: number | undefined;
  dropped: Response["dropped"];
}) {
  const pairCount = rows.reduce((sum, r) => sum + r.pairs, 0);
  const outlierSwing = dropped?.outlierSwing ?? 0;
  const missingMyMmr = dropped?.missingMyMmr ?? 0;
  const untrustedMyMmr = dropped?.untrustedMyMmr ?? 0;
  const missingIdentity = dropped?.missingIdentity ?? 0;
  const excludedNonRanked1v1 = dropped?.excludedNonRanked1v1 ?? 0;
  const brokenBoundaries =
    (dropped?.nextMissingMyMmr ?? 0) +
    (dropped?.nextUntrustedMyMmr ?? 0);
  const signMismatch = dropped?.signMismatch ?? 0;
  const unsupportedResult = dropped?.unsupportedResult ?? 0;
  if (!totalGames && !outlierSwing && !missingMyMmr && !untrustedMyMmr) {
    return null;
  }
  const reasons: string[] = [];
  if (missingMyMmr > 0) {
    reasons.push(`${missingMyMmr} missing MMR data`);
  }
  if (outlierSwing > 0) {
    reasons.push(
      `${outlierSwing} outlier swing${outlierSwing === 1 ? "" : "s"} (>±150)`,
    );
  }
  if (untrustedMyMmr > 0) {
    reasons.push(
      `${untrustedMyMmr} unverified MMR value${untrustedMyMmr === 1 ? "" : "s"}`,
    );
  }
  if (brokenBoundaries > 0) {
    reasons.push(
      `${brokenBoundaries} pair boundar${brokenBoundaries === 1 ? "y" : "ies"} broken by MMR gaps`,
    );
  }
  if (signMismatch > 0) {
    reasons.push(
      `${signMismatch} result/MMR mismatch${signMismatch === 1 ? "" : "es"}`,
    );
  }
  if (unsupportedResult > 0) {
    reasons.push(`${unsupportedResult} undecided result${unsupportedResult === 1 ? "" : "s"}`);
  }
  if (missingIdentity > 0) {
    reasons.push(`${missingIdentity} missing account or ladder race`);
  }
  if (excludedNonRanked1v1 > 0) {
    reasons.push(`${excludedNonRanked1v1} non-ranked-1v1 excluded`);
  }
  const pairLabel = `${pairCount} pair${pairCount === 1 ? "" : "s"}`;
  let head = pairLabel;
  if (typeof eligibleGames === "number" && eligibleGames > 0) {
    const filteredSuffix =
      typeof totalGames === "number" && totalGames !== eligibleGames
        ? ` (${totalGames} filtered)`
        : "";
    head = `${pairLabel} from ${eligibleGames} eligible ranked 1v1 game${eligibleGames === 1 ? "" : "s"}${filteredSuffix}`;
  } else if (typeof totalGames === "number" && totalGames > 0) {
    head = `${pairLabel} from ${totalGames} filtered game${totalGames === 1 ? "" : "s"}`;
  }
  return (
    <p className="mt-2 text-micro text-text-dim">
      {head}
      {reasons.length ? ` · ${reasons.join(" · ")}` : ""}
    </p>
  );
}

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

type DroppedCoverage = {
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

type MatchupCoverage = {
  race: MatchupRow["race"];
  totalGames: number;
  eligibleGames: number;
  measuredGames: number;
  dropped: DroppedCoverage;
};

type Response = {
  matchups: MatchupRow[];
  coverage?: MatchupCoverage[];
  totalGames?: number;
  eligibleGames?: number;
  dropped?: DroppedCoverage;
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

function compactCoverageReasons(dropped: DroppedCoverage | undefined): string[] {
  if (!dropped) return [];
  const reasons: string[] = [];
  const brokenNext =
    (dropped.nextMissingMyMmr ?? 0) +
    (dropped.nextUntrustedMyMmr ?? 0);
  if (dropped.excludedNonRanked1v1) {
    reasons.push(`${dropped.excludedNonRanked1v1} not ranked 1v1`);
  }
  if (dropped.missingIdentity) {
    reasons.push(`${dropped.missingIdentity} missing account/race`);
  }
  if (dropped.missingMyMmr) {
    reasons.push(`${dropped.missingMyMmr} missing start MMR`);
  }
  if (dropped.untrustedMyMmr) {
    reasons.push(`${dropped.untrustedMyMmr} unverified start MMR`);
  }
  if (dropped.terminalGame) {
    reasons.push(
      `${dropped.terminalGame} sequence-ending (no later reading)`,
    );
  }
  if (brokenNext) reasons.push(`${brokenNext} broken next reading`);
  if (dropped.outlierSwing) {
    reasons.push(`${dropped.outlierSwing} swing past ±150`);
  }
  if (dropped.signMismatch) {
    reasons.push(`${dropped.signMismatch} result/MMR mismatch`);
  }
  if (dropped.unsupportedResult) {
    reasons.push(`${dropped.unsupportedResult} undecided result`);
  }
  return reasons;
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
 * average delta so the totals are never read in a vacuum. One accepted
 * replay-to-replay reading pair measures the MMR result of one anchor game;
 * user-facing copy therefore calls these "measured games", not "pairs".
 */
export function NetMmrByMatchupChart() {
  const { filters, dbRev } = useFilters();
  const [selectedRace, setSelectedRace] = useState<NetMmrRace | null>(null);
  const { data, isLoading } = useApi<Response>(
    `/v1/mmr-by-matchup${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    const coverageByRace = new Map(
      (data?.coverage || []).map((row) => [row.race, row]),
    );
    const matchups = (data?.matchups || [])
      .map((m) => ({ ...m, pairs: m.pairs ?? m.games }))
      .filter((m) => m.pairs > 0);
    return matchups
      .map((m) => ({
        ...m,
        meta: RACE_META[m.race] || RACE_META.U,
        coverage: coverageByRace.get(m.race),
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
                ? "No measured ranked 1v1 MMR changes"
                : "Not enough MMR-tagged games"
          }
          sub={
            untrusted > 0
              ? untrustedMmrMessage(untrusted)
              : "This chart needs adjacent uploaded ranked 1v1 replays with verified game-time MMR readings."
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
        Your MMR gained (▶) or lost (◀) in games against each opponent race.
        Each game&apos;s change is measured from its starting MMR and the next
        uploaded replay&apos;s starting MMR on the same Battle.net account/server
        and selected ladder race. Missing or unverified readings break the
        sequence; impossible result/delta signs and swings past ±150 are
        excluded and reported below.
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
        {rows.map((r) => {
          const totalForRace = r.coverage?.totalGames;
          const measuredLabel =
            typeof totalForRace === "number" && totalForRace > r.pairs
              ? `${r.pairs} of ${totalForRace} games measured`
              : `${r.pairs} measured game${r.pairs === 1 ? "" : "s"}`;
          const coverageReasons = compactCoverageReasons(r.coverage?.dropped);
          return (
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
                {measuredLabel} ·{" "}
                {pct1(r.winRate)} WR · avg{" "}
                {r.avgDelta > 0 ? "+" : ""}
                {r.avgDelta}/game
              </div>
              {coverageReasons.length > 0 ? (
                <div className="mt-1 text-micro leading-snug text-text-muted">
                  Not measured: {coverageReasons.join(" · ")}
                </div>
              ) : null}
              <div className="mt-1.5 flex items-center justify-end gap-0.5 text-micro font-medium text-accent opacity-80 transition-opacity group-hover:opacity-100">
                View opponents
                <ChevronRight aria-hidden className="h-3.5 w-3.5" />
              </div>
            </button>
          );
        })}
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
  const measuredGames = rows.reduce((sum, r) => sum + r.pairs, 0);
  const outlierSwing = dropped?.outlierSwing ?? 0;
  const missingMyMmr = dropped?.missingMyMmr ?? 0;
  const untrustedMyMmr = dropped?.untrustedMyMmr ?? 0;
  const missingIdentity = dropped?.missingIdentity ?? 0;
  const excludedNonRanked1v1 = dropped?.excludedNonRanked1v1 ?? 0;
  const terminalGame = dropped?.terminalGame ?? 0;
  const brokenBoundaries =
    (dropped?.nextMissingMyMmr ?? 0) +
    (dropped?.nextUntrustedMyMmr ?? 0);
  const signMismatch = dropped?.signMismatch ?? 0;
  const unsupportedResult = dropped?.unsupportedResult ?? 0;
  if (
    !totalGames
    && !outlierSwing
    && !missingMyMmr
    && !untrustedMyMmr
    && !terminalGame
  ) {
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
      `${brokenBoundaries} game${brokenBoundaries === 1 ? "" : "s"} blocked by a missing or unverified next MMR reading`,
    );
  }
  if (terminalGame > 0) {
    reasons.push(
      `${terminalGame} sequence-ending game${terminalGame === 1 ? " has" : "s have"} no later MMR reading`,
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
  const measuredLabel =
    `${measuredGames} measured game${measuredGames === 1 ? "" : "s"}`;
  let head = measuredLabel;
  if (typeof eligibleGames === "number" && eligibleGames > 0) {
    const filteredSuffix =
      typeof totalGames === "number" && totalGames !== eligibleGames
        ? ` (${totalGames} filtered)`
        : "";
    head = `${measuredLabel} from ${eligibleGames} eligible ranked 1v1 game${eligibleGames === 1 ? "" : "s"}${filteredSuffix}`;
  } else if (typeof totalGames === "number" && totalGames > 0) {
    head = `${measuredLabel} from ${totalGames} filtered game${totalGames === 1 ? "" : "s"}`;
  }
  return (
    <p className="mt-2 text-micro text-text-dim">
      {head}
      {reasons.length ? ` · ${reasons.join(" · ")}` : ""}
    </p>
  );
}

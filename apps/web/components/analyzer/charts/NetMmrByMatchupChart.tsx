"use client";

import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Cell,
  Tooltip,
} from "recharts";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { pct1 } from "@/lib/format";
import {
  netMmrByMatchupPath,
  NET_MMR_MATCHUP_ORDER,
  type NetMmrByMatchupResponseBase,
  type NetMmrMatchup,
  type NetMmrPlayedRace,
} from "@/lib/netMmrOpponents";
import { clientTimezone } from "@/lib/timeseries";
import { NetMmrRaceOpponentsModal } from "./NetMmrRaceOpponentsModal";
import { ChartTooltip } from "./ChartTooltip";

type MatchupRow = {
  matchup: NetMmrMatchup;
  myRace: NetMmrPlayedRace;
  opponentRace: NetMmrPlayedRace;
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
  matchup: string;
  totalGames: number;
  eligibleGames: number;
  measuredGames: number;
  dropped: DroppedCoverage;
};

type Response = NetMmrByMatchupResponseBase & {
  matchups: MatchupRow[];
  coverage?: MatchupCoverage[];
  totalGames?: number;
  eligibleGames?: number;
  dropped?: DroppedCoverage;
};

const RACE_NAMES: Record<NetMmrPlayedRace, string> = {
  P: "Protoss", T: "Terran", Z: "Zerg",
};

const COLOR_SUCCESS = "rgb(var(--success))";
const COLOR_DANGER = "rgb(var(--danger))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_TEXT_DIM = "rgb(var(--text-dim))";
const SMALL_SAMPLE_GAMES = 20;

function formatMmr(value: number | null, perGame: boolean): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${(value || 0).toLocaleString(undefined, { minimumFractionDigits: perGame ? 1 : 0, maximumFractionDigits: perGame ? 1 : 0 })}`;
}

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
 * Attributes each verified next-MMR delta to the concrete matchup of the
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
  const { isGlobal } = useTrendsDataScope();
  const { filters, dbRev } = useFilters();
  const descriptionId = useId();
  const [metric, setMetric] = useState<"netMmr" | "avgDelta">("netMmr");
  const [selectedMatchup, setSelectedMatchup] = useState<{
    myRace: NetMmrPlayedRace; opponentRace: NetMmrPlayedRace;
  } | null>(null);
  const tz = useMemo(() => clientTimezone(), []);
  const { data, isLoading, error, mutate } = useApi<Response>(
    netMmrByMatchupPath(filters, tz, dbRev),
  );

  const rows = useMemo(() => {
    const coverageByMatchup = new Map(
      (data?.coverage || []).map((row) => [row.matchup, row]),
    );
    const measuredByMatchup = new Map((data?.matchups || []).map((row) => [row.matchup, row]));
    return NET_MMR_MATCHUP_ORDER.flatMap((matchup) => {
      const measured = measuredByMatchup.get(matchup);
      const coverage = coverageByMatchup.get(matchup);
      if (!measured && !coverage?.totalGames) return [];
      const myRace = matchup[0] as NetMmrPlayedRace;
      const opponentRace = matchup[2] as NetMmrPlayedRace;
      const pairs = measured?.pairs ?? measured?.games ?? 0;
      return [{
        matchup, myRace, opponentRace, pairs, coverage,
        label: `${RACE_NAMES[myRace]} vs ${RACE_NAMES[opponentRace]}`,
        netMmr: pairs ? measured?.netMmr ?? null : null,
        winRate: pairs ? measured?.winRate ?? null : null,
        avgDelta: pairs ? measured?.avgDelta ?? null : null,
      }];
    });
  }, [data]);

  const xDomain = useMemo<[number, number]>(() => {
    if (!rows.length) return [-100, 100];
    let mn = 0;
    let mx = 0;
    for (const r of rows) {
      const value = r[metric];
      if (value === null) continue;
      if (value < mn) mn = value;
      if (value > mx) mx = value;
    }
    const reach = Math.max(Math.abs(mn), Math.abs(mx), metric === "avgDelta" ? 5 : 25);
    const step = metric === "avgDelta" ? 2 : 10;
    const padded = Math.ceil((reach * 1.15) / step) * step;
    return [-padded, padded];
  }, [rows, metric]);

  const perGame = metric === "avgDelta";
  const unit = perGame ? "MMR/game" : "MMR";
  const valueColumnWidth = Math.max(66, ...rows.map((row) => formatMmr(row[metric], perGame).length * 7 + 8));
  const measuredRows = rows.filter((row) => row.avgDelta !== null).sort((a, b) => Math.abs(b.avgDelta!) - Math.abs(a.avgDelta!));
  const scaleLeader = perGame && measuredRows.length > 1 && Math.abs(measuredRows[0].avgDelta!) > Math.max(5, Math.abs(measuredRows[1].avgDelta!) * 5)
    ? measuredRows[0] : null;

  if (error) return <TrendsRequestError title="Net MMR by matchup" error={error} retry={mutate} />;

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
        {isGlobal ? "Total" : "Your"} MMR gained or lost by matchup. Total shows the contribution to rating change;
        per game compares matchups with different amounts of play. Small samples can move sharply.
      </p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="MMR comparison measure" className="flex rounded-lg border border-border p-1">
          {([
            ["netMmr", "Total MMR"],
            ["avgDelta", "Per game"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
              className={`min-h-11 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${metric === value ? "bg-accent/15 text-accent" : "text-text-dim hover:bg-bg-elevated"}`}
            >{label}</button>
          ))}
        </div>
        <span className="text-micro text-text-dim">{metric === "avgDelta" ? "MMR per measured game" : "Total measured MMR"} · ← lost / gained →</span>
      </div>
      <div style={{ height: Math.max(180, rows.length * 48 + 36) }} aria-label={perGame ? "Average MMR change per measured game by played matchup" : "Net MMR by played matchup"}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            accessibilityLayer
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} horizontal={false} />
            <XAxis
              type="number"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              domain={xDomain}
              ticks={[xDomain[0], 0, xDomain[1]]}
              tickFormatter={(v: number) => (v > 0 ? `+${v}` : `${v}`)}
            />
            <YAxis
              type="category"
              dataKey="matchup"
              stroke={COLOR_TEXT_DIM}
              fontSize={12}
              width={76}
              tickMargin={4}
              interval={0}
              tick={({ x, y, payload }) => {
                const row = rows.find((entry) => entry.matchup === payload.value);
                return <text x={x} y={y} textAnchor="end" fill={COLOR_TEXT_DIM} fontSize={12}>
                  <tspan x={x} dy={-3}>{payload.value}</tspan>
                  <tspan x={x} dy={14} fontSize={10}>{row?.pairs.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })} measured</tspan>
                </text>;
              }}
            />
            <YAxis
              yAxisId="values"
              type="category"
              dataKey="matchup"
              orientation="right"
              width={valueColumnWidth}
              axisLine={false}
              tickLine={false}
              interval={0}
              tick={({ x, y, payload }) => {
                const value = rows.find((entry) => entry.matchup === payload.value)?.[metric] ?? null;
                return <text x={x} y={y} dy="0.35em" textAnchor="start" fill="rgb(var(--text))" fontSize={12} fontWeight={600}>{formatMmr(value, perGame)}</text>;
              }}
            />
            <ReferenceLine x={0} stroke={COLOR_TEXT_DIM} strokeOpacity={0.65} />
            <Tooltip
              cursor={false}
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                const value = payload?.[0]?.value;
                if (!active || typeof value !== "number" || !Number.isFinite(value)) return null;
                const row = payload?.[0]?.payload as typeof rows[number];
                return <ChartTooltip header={row.label || label} rows={[{
                  label: metric === "avgDelta" ? "MMR per measured game" : "Net MMR",
                  value: formatMmr(value, perGame),
                  dot: value >= 0 ? COLOR_SUCCESS : COLOR_DANGER,
                }, { label: "Measured games", value: row.pairs.toLocaleString() }]} />;
              }}
            />
            <Bar dataKey={metric} radius={[4, 4, 4, 4]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell
                  key={r.matchup}
                  fill={r.netMmr === null ? COLOR_TEXT_DIM : r.netMmr >= 0 ? COLOR_SUCCESS : COLOR_DANGER}
                  fillOpacity={r.pairs < SMALL_SAMPLE_GAMES ? 0.45 : 0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {scaleLeader && <p role="status" className="mt-2 rounded-lg border border-border bg-bg-elevated/50 px-3 py-2 text-micro leading-relaxed text-text-muted">
        {scaleLeader.matchup} sets the scale at {formatMmr(scaleLeader.avgDelta, true)} MMR/game from {scaleLeader.pairs.toLocaleString()} measured {scaleLeader.pairs === 1 ? "game" : "games"}.
        {scaleLeader.pairs < SMALL_SAMPLE_GAMES ? " Small sample; this average can change sharply." : " Smaller averages sit close to zero."}
      </p>}
      <details className="mt-3 text-micro text-text-dim">
        <summary className="cursor-pointer py-1 font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">How MMR changes are measured</summary>
        <p className="mt-1 leading-relaxed">
          The played race is listed first. Random-queue games use the race actually played.
          Each change compares the game&apos;s starting MMR with the next uploaded replay&apos;s starting MMR
          on the same Battle.net account/server and selected ladder race. Missing or unverified readings
          break the sequence; impossible result/delta signs and swings past ±150 are excluded.
          These are changes observed between uploaded replays; coverage is reported below.
        </p>
      </details>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        {rows.map((r) => {
          const primary = r[metric];
          const totalForRace = r.coverage?.totalGames;
          const measuredLabel =
            typeof totalForRace === "number" && totalForRace > r.pairs
              ? `${r.pairs} of ${totalForRace} games measured`
              : `${r.pairs} measured game${r.pairs === 1 ? "" : "s"}`;
          const coverageReasons = compactCoverageReasons(r.coverage?.dropped);
          return (
            <button
              type="button"
              key={r.matchup}
              aria-haspopup="dialog"
              aria-expanded={selectedMatchup?.myRace === r.myRace && selectedMatchup?.opponentRace === r.opponentRace}
              aria-label={r.pairs ? `View ${r.matchup} MMR impact by opponent` : `${r.matchup}: no measured MMR changes`}
              aria-describedby={`${descriptionId}-${r.matchup}-net ${descriptionId}-${r.matchup}-metrics`}
              disabled={!r.pairs}
              onClick={() => setSelectedMatchup({ myRace: r.myRace, opponentRace: r.opponentRace })}
              className="group rounded border border-border bg-bg-elevated/50 px-3 py-2.5 text-left transition-colors enabled:hover:border-accent/60 enabled:hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="text-sm font-semibold text-text"
                  title={r.label}
                >
                  {r.matchup}
                </span>
                <span
                  className="whitespace-nowrap text-sm font-semibold tabular-nums"
                  style={{ color: primary === null || primary === 0 ? COLOR_TEXT_DIM : primary > 0 ? COLOR_SUCCESS : COLOR_DANGER }}
                >
                  {formatMmr(primary, perGame)}
                  <span className="ml-1 text-micro font-normal text-text-dim">{unit}</span>
                </span>
              </div>
              <span id={`${descriptionId}-${r.matchup}-net`} className="sr-only">
                {r.label}. {primary === null ? "No measured MMR change." : `${perGame ? "MMR per measured game" : "Net MMR"} ${formatMmr(primary, perGame)}.`}
              </span>
              <div id={`${descriptionId}-${r.matchup}-metrics`} className="mt-0.5 text-micro tabular-nums text-text-dim">
                {measuredLabel}
                {r.winRate !== null && r.avgDelta !== null ? <> · {pct1(r.winRate)} WR · {perGame ? `${formatMmr(r.netMmr, false)} MMR total` : `avg ${r.avgDelta > 0 ? "+" : ""}${r.avgDelta}/game`}</> : null}
              </div>
              {r.pairs > 0 && r.pairs < SMALL_SAMPLE_GAMES ? <div className="mt-1 text-micro text-text-dim">Small sample · fewer than {SMALL_SAMPLE_GAMES} measured games</div> : null}
              {coverageReasons.length > 0 ? (
                <div className="mt-1 text-micro leading-snug text-text-muted">
                  Not measured: {coverageReasons.join(" · ")}
                </div>
              ) : null}
              {r.pairs ? <div className="mt-1.5 flex items-center justify-end gap-0.5 text-micro font-medium text-accent opacity-80 transition-opacity group-hover:opacity-100">
                View opponents
                <ChevronRight aria-hidden className="h-3.5 w-3.5" />
              </div> : <div className="mt-1.5 text-micro text-text-muted">No measured MMR change yet</div>}
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
      {(data?.coverage || []).some((row) => !NET_MMR_MATCHUP_ORDER.includes(row.matchup as NetMmrMatchup)) ? (
        <p className="mt-1 text-micro text-text-dim">Games without both concrete played races remain in coverage totals and cannot be assigned to a matchup.</p>
      ) : null}
      <NetMmrRaceOpponentsModal
        race={selectedMatchup?.opponentRace ?? null}
        myRace={selectedMatchup?.myRace ?? null}
        onClose={() => setSelectedMatchup(null)}
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

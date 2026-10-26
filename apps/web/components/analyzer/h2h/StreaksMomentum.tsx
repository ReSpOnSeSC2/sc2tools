"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ChartFrame, type ChartTableColumn } from "@/components/analyzer/charts/ChartFrame";
import { useChartKit, isLowSample } from "@/lib/charts/theme";
import { fmtDate } from "@/lib/format";
import { decidedOnly, gameOutcome, type H2HGame } from "@/lib/h2hSeries";
import {
  momentumDelta,
  momentumScore,
  streaksSummary,
  type StreakRun,
} from "@/lib/h2hStreaks";

type Props = {
  chronoGames: H2HGame[];
  presetShort: string;
  presetLong: string;
  opponentName: string;
  onSelectGame: (gameId: string) => void;
};

const MOMENTUM_WINDOW = 10;

function streakColumns(onSelectGame: Props["onSelectGame"]): readonly ChartTableColumn<H2HGame>[] {
  return [
    { key: "date", label: "Date", render: row => fmtDate(row.date) },
    { key: "result", label: "Result", render: row => gameOutcome(row) === "W" ? "Win" : gameOutcome(row) === "L" ? "Loss" : "Unknown" },
    { key: "map", label: "Map", render: row => row.map || "—" },
    { key: "build", label: "My build", render: row => row.my_build || "—" },
    { key: "strategy", label: "Opponent strategy", render: row => row.opp_strategy || "—" },
    { key: "game", label: "Game", render: row => row.id ? <Button variant="ghost" size="sm" className="min-h-11" aria-label={`Select game from ${fmtDate(row.date)}`} onClick={() => onSelectGame(row.id!)}>View game</Button> : "Unavailable" },
  ];
}

/**
 * View 2 — Performance Streaks & Momentum.
 *
 * Headline strip → streak ribbon → expandable streak history. The
 * momentum gauge is a tiny inline SVG bar that runs from -100 (deep
 * red) through 0 (text-dim) to +100 (deep green).
 */
export function StreaksMomentum({
  chronoGames,
  presetShort,
  presetLong,
  opponentName,
  onSelectGame,
}: Props) {
  const kit = useChartKit();
  const decided = useMemo(() => decidedOnly(chronoGames), [chronoGames]);
  const summary = useMemo(() => streaksSummary(chronoGames), [chronoGames]);
  const score = useMemo(() => momentumScore(chronoGames, MOMENTUM_WINDOW), [chronoGames]);
  const delta = useMemo(
    () => momentumDelta(chronoGames, MOMENTUM_WINDOW),
    [chronoGames],
  );
  const [pulseIndexes, setPulseIndexes] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    if (kit.reducedMotion) { if (pulseIndexes.size) setPulseIndexes(new Set()); return; }
    if (pulseIndexes.size === 0) return;
    const t = window.setTimeout(() => setPulseIndexes(new Set()), 2000);
    return () => window.clearTimeout(t);
  }, [pulseIndexes, kit.reducedMotion]);

  if (decided.length === 0) {
    return (
      <ChartFrame title="Streaks and momentum" summary={`No decided games against ${opponentName} in ${presetLong}.`} rows={decided} columns={streakColumns(onSelectGame)} empty={<EmptyState title="No decided games yet" sub={`No wins or losses against ${opponentName} in ${presetLong}.`} />}>
      <EmptyState
        title="No decided games yet"
        sub={`No wins or losses against ${opponentName} in ${presetLong}.`}
      />
      </ChartFrame>
    );
  }

  const figcaption = buildFigcaption({
    opponent: opponentName,
    presetLong,
    current: summary.current,
    longestWin: summary.longestWin,
    longestLoss: summary.longestLoss,
    score,
  });

  const highlightRun = (run: StreakRun) => {
    const indexes = new Set<number>();
    for (let i = run.start; i <= run.end; i++) indexes.add(i);
    if (!kit.reducedMotion) setPulseIndexes(indexes);
    const firstId = run.games[0]?.id;
    if (firstId) onSelectGame(firstId);
  };

  return (
    <ChartFrame title="Streaks and momentum" summary={`${figcaption} ${decided.length} decided games; momentum uses up to ${MOMENTUM_WINDOW} recent decided games.`} rows={decided} columns={streakColumns(onSelectGame)}>
    <figure className="m-0 space-y-4" aria-label="Streaks and momentum">
      <HeadlineStrip
        current={summary.current}
        longestWin={summary.longestWin}
        longestLoss={summary.longestLoss}
        score={score}
        delta={delta}
        presetShort={presetShort}
        kit={kit}
        sampleSize={Math.min(MOMENTUM_WINDOW, decided.length)}
      />
      <p className="text-caption text-text-muted">{decided.length} decided games in this view{isLowSample(decided.length) ? " · small sample" : ""}. W and L mark recorded outcomes; momentum summarizes up to 10 recent decided games.</p>
      <StreakRibbon
        decided={decided}
        currentIndexes={summary.current.indexes}
        pulseIndexes={pulseIndexes}
        onSelectGame={onSelectGame}
        kit={kit}
      />
      <NotableRunsList
        runs={summary.notableRuns}
        onActivate={highlightRun}
      />
    </figure>
    </ChartFrame>
  );
}

function HeadlineStrip({
  current,
  longestWin,
  longestLoss,
  score,
  delta,
  presetShort,
  kit,
  sampleSize,
}: {
  current: ReturnType<typeof streaksSummary>["current"];
  longestWin: StreakRun | null;
  longestLoss: StreakRun | null;
  score: number;
  delta: number | null;
  presetShort: string;
  kit: ReturnType<typeof useChartKit>;
  sampleSize: number;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <MetricChip
        label="Current streak"
        sub={`in ${presetShort}`}
        value={
          current.kind == null
            ? "—"
            : `${current.kind === "win" ? "W" : "L"}${current.count}`
        }
        valueClass={
          current.kind === "win"
            ? "text-success"
            : current.kind === "loss"
              ? "text-danger"
              : "text-text-muted"
        }
        glyph={
          current.kind === "win" ? "▲" : current.kind === "loss" ? "▼" : null
        }
      />
      <MetricChip
        label="Longest win"
        sub={`in ${presetShort}`}
        value={longestWin ? `W${longestWin.count}` : "—"}
        valueClass="text-success"
        glyph={longestWin ? "▲" : null}
      />
      <MetricChip
        label="Longest loss"
        sub={`in ${presetShort}`}
        value={longestLoss ? `L${longestLoss.count}` : "—"}
        valueClass="text-danger"
        glyph={longestLoss ? "▼" : null}
      />
      <MomentumChip score={score} delta={delta} presetShort={presetShort} kit={kit} sampleSize={sampleSize} />
    </div>
  );
}

function MetricChip({
  label,
  sub,
  value,
  valueClass,
  glyph,
}: {
  label: string;
  sub: string;
  value: string;
  valueClass: string;
  glyph: string | null;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 min-w-[120px]">
      <span className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <span className={`text-h3 font-semibold tabular-nums ${valueClass}`}>
        {glyph ? <span className="mr-1 text-base" aria-hidden>{glyph}</span> : null}
        {value}
      </span>
      <span className="text-micro text-text-dim">{sub}</span>
    </div>
  );
}

function MomentumChip({
  score,
  delta,
  presetShort,
  kit,
  sampleSize,
}: {
  score: number;
  delta: number | null;
  presetShort: string;
  kit: ReturnType<typeof useChartKit>;
  sampleSize: number;
}) {
  const gradientId = useId();
  // Map score [-100, 100] to [0, 100] for the SVG x position.
  const x = ((score + 100) / 200) * 100;
  const deltaArrow =
    delta == null ? null : delta > 5 ? "▲" : delta < -5 ? "▼" : "▬";
  const deltaClass =
    delta == null
      ? "text-text-dim"
      : delta > 5
        ? "text-success"
        : delta < -5
          ? "text-danger"
          : "text-text-dim";
  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 min-w-[200px]">
      <span className="text-micro uppercase tracking-wider text-text-dim">
        Momentum
      </span>
      <div className="flex items-baseline gap-2">
        <span
          className={`text-h3 font-semibold tabular-nums ${
            score > 0 ? "text-success" : score < 0 ? "text-danger" : "text-text-muted"
          }`}
        >
          {score > 0 ? "+" : ""}
          {score}
        </span>
        {delta != null ? (
          <span className={`text-caption tabular-nums ${deltaClass}`} title="Change vs. previous 10-game window">
            {deltaArrow} {delta > 0 ? "+" : ""}
            {delta}
          </span>
        ) : null}
      </div>
      <svg
        viewBox="0 0 100 12"
        preserveAspectRatio="none"
        className="mt-1 h-3 w-full"
        role="img"
        aria-label={`Momentum gauge ${score} of 100`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={kit.tokens.danger} />
            <stop offset="50%" stopColor={kit.axis} />
            <stop offset="100%" stopColor={kit.tokens.success} />
          </linearGradient>
        </defs>
        <rect x="0" y="3" width="100" height="6" rx="3" fill={`url(#${gradientId})`} fillOpacity={isLowSample(sampleSize) ? 0.45 : 1} />
        <line
          x1="50"
          x2="50"
          y1="2"
          y2="10"
          stroke={kit.tokens.text}
          strokeWidth="0.5"
        />
        <rect
          x={Math.max(0, Math.min(100, x) - 1)}
          y="0.5"
          width="2"
          height="11"
          rx="1"
          fill={kit.tokens.text}
          stroke={kit.tokens.bgSurface}
          strokeWidth="0.4"
        />
      </svg>
      <span className="mt-0.5 text-micro text-text-dim">
        last {MOMENTUM_WINDOW} games · n={sampleSize} decided · {presetShort}{isLowSample(sampleSize) ? " · small sample" : ""}
      </span>
    </div>
  );
}

function StreakRibbon({
  decided,
  currentIndexes,
  pulseIndexes,
  onSelectGame,
  kit,
}: {
  decided: H2HGame[];
  currentIndexes: number[];
  pulseIndexes: Set<number>;
  onSelectGame: (gameId: string) => void;
  kit: ReturnType<typeof useChartKit>;
}) {
  const currentSet = useMemo(() => new Set(currentIndexes), [currentIndexes]);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-caption">
        <span className="font-semibold text-text">Streak ribbon</span>
        <span className="text-text-dim">
          oldest → newest · {decided.length} game{decided.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-0.5">
        {decided.map((g, i) => {
          const o = gameOutcome(g);
          const isWin = o === "W";
          return (
            <RibbonCell
              key={g.id || `_idx_${i}`}
              game={g}
              isWin={isWin}
              isCurrent={currentSet.has(i)}
              isPulsing={pulseIndexes.has(i)}
              onSelect={onSelectGame}
              kit={kit}
            />
          );
        })}
      </div>
    </div>
  );
}

function RibbonCell({
  game,
  isWin,
  isCurrent,
  isPulsing,
  onSelect,
  kit,
}: {
  game: H2HGame;
  isWin: boolean;
  isCurrent: boolean;
  isPulsing: boolean;
  onSelect: (id: string) => void;
  kit: ReturnType<typeof useChartKit>;
}) {
  const id = game.id || "";
  const tooltip = [
    fmtDate(game.date),
    game.map || "—",
    `${isWin ? "Win" : "Loss"}`,
    game.opp_strategy ? `vs ${game.opp_strategy}` : null,
    game.my_build ? `me ${game.my_build}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const ringColour = kit.tokens.text;
  const baseClasses = isWin
    ? "bg-success hover:opacity-90"
    : "bg-danger hover:opacity-90";
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      disabled={!id}
      onClick={() => id && onSelect(id)}
      className={[
        "aspect-square rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg disabled:cursor-default",
        baseClasses,
        isPulsing && !kit.reducedMotion ? "motion-safe:animate-pulse" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        isCurrent
          ? { boxShadow: `inset 0 0 0 2px ${ringColour}` }
          : undefined
      }
    >
      <span aria-hidden className="block text-caption font-bold leading-none text-bg">
        {isWin ? "W" : "L"}
      </span>
    </button>
  );
}

function NotableRunsList({
  runs,
  onActivate,
}: {
  runs: StreakRun[];
  onActivate: (run: StreakRun) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <details className="rounded-lg border border-border bg-bg-elevated/40 px-3 py-2">
      <summary className="cursor-pointer select-none text-caption text-text-muted hover:text-text">
        Notable streaks ({runs.length})
      </summary>
      <ul className="mt-2 space-y-1 text-caption">
        {runs.map((run) => (
          <li key={`${run.start}-${run.end}`}>
            <button
              type="button"
              onClick={() => onActivate(run)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                aria-hidden
                className={
                  run.kind === "win"
                    ? "text-success"
                    : "text-danger"
                }
              >
                {run.kind === "win" ? "▲" : "▼"}
              </span>
              <span
                className={`font-semibold tabular-nums ${
                  run.kind === "win" ? "text-success" : "text-danger"
                }`}
              >
                {run.kind === "win" ? "W" : "L"}
                {run.count}
              </span>
              <span className="text-text-dim">·</span>
              <span className="text-text-muted">
                {fmtDate(run.games[0]?.date)} →{" "}
                {fmtDate(run.games[run.games.length - 1]?.date)}
              </span>
              <span className="ml-auto text-micro text-text-dim">
                {distinctMaps(run)} map{distinctMaps(run) === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function distinctMaps(run: StreakRun): number {
  const set = new Set<string>();
  for (const g of run.games) {
    const m = (g.map || "").trim();
    if (m) set.add(m);
  }
  return set.size;
}

function buildFigcaption(args: {
  opponent: string;
  presetLong: string;
  current: ReturnType<typeof streaksSummary>["current"];
  longestWin: StreakRun | null;
  longestLoss: StreakRun | null;
  score: number;
}): string {
  const cur =
    args.current.kind == null
      ? "no current streak"
      : `current ${args.current.kind} streak of ${args.current.count}`;
  const longW = args.longestWin
    ? `longest win streak ${args.longestWin.count}`
    : "no win streaks";
  const longL = args.longestLoss
    ? `longest loss streak ${args.longestLoss.count}`
    : "no loss streaks";
  return (
    `Streaks vs ${args.opponent} in ${args.presetLong}: ${cur}, ${longW}, ` +
    `${longL}. Momentum ${args.score} of 100.`
  );
}

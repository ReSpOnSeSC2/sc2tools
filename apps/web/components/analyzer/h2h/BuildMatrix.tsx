"use client";

import { useMemo } from "react";
import { EmptyState } from "@/components/ui/Card";
import { wrColor, wrRamp } from "@/lib/format";
import {
  buildMatchupGrid,
  cellKey,
  type H2HGame,
  type MatrixCell,
} from "@/lib/h2hSeries";
import { raceAccent, raceFullName, type RaceLetter } from "./shared/raceAccent";

export type BuildMatchupSelection = {
  myBuild: string;
  oppStrategy: string;
};

type Props = {
  chronoGames: H2HGame[];
  matrixSize: 5 | 10 | "all";
  onMatrixSizeChange: (size: 5 | 10 | "all") => void;
  selected: BuildMatchupSelection | null;
  onSelect: (sel: BuildMatchupSelection | null) => void;
  presetLong: string;
  opponentName: string;
};

const SIZE_OPTIONS: ReadonlyArray<{ value: 5 | 10 | "all"; label: string }> = [
  { value: 5, label: "Top 5" },
  { value: 10, label: "Top 10" },
  { value: "all", label: "All" },
];

const SIZE_CAP = 30;

/**
 * View 4 — Build Matchup Matrix.
 *
 * Builds a top-K my-build × opponent-strategy crosstab. Each cell
 * shows WR% and W-L over total. Clicking a cell filters the
 * AllGamesTable to those games (lifted via the `onSelect` prop).
 */
export function BuildMatrix({
  chronoGames,
  matrixSize,
  onMatrixSizeChange,
  selected,
  onSelect,
  presetLong,
  opponentName,
}: Props) {
  const grid = useMemo(() => {
    const limit = matrixSize === "all" ? SIZE_CAP : matrixSize;
    return buildMatchupGrid(chronoGames, limit, limit);
  }, [chronoGames, matrixSize]);

  const insufficient = grid.myBuilds.length < 2 || grid.oppStrategies.length < 2;

  return (
    <figure
      className="m-0 space-y-3"
      style={{ touchAction: "pan-y" }}
      aria-label="Build matchup matrix"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SizeToggle value={matrixSize} onChange={onMatrixSizeChange} />
        {selected ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-caption text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden>×</span>
            {selected.myBuild} → {selected.oppStrategy}
          </button>
        ) : null}
      </div>

      {insufficient ? (
        <EmptyState
          title="Not enough variety"
          sub={`Not enough variety in ${presetLong} — both you and ${opponentName} need to use more than one build for a matrix.`}
        />
      ) : (
        <>
          <MatrixTable
            grid={grid}
            selected={selected}
            onSelect={onSelect}
          />
          <Legend
            oppStrategies={grid.oppStrategies}
            races={grid.oppStrategyRace}
          />
          <figcaption className="sr-only">
            Build vs strategy crosstab against {opponentName} in {presetLong}.{" "}
            {grid.myBuilds.length} of your builds against{" "}
            {grid.oppStrategies.length} opponent strategies.
          </figcaption>
        </>
      )}
    </figure>
  );
}

function MatrixTable({
  grid,
  selected,
  onSelect,
}: {
  grid: ReturnType<typeof buildMatchupGrid>;
  selected: BuildMatchupSelection | null;
  onSelect: (sel: BuildMatchupSelection | null) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated/40">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wider text-text-dim">
          <tr>
            <th className="sticky left-0 bg-bg-elevated px-3 py-2 text-left">
              My build ↓ · Their strategy →
            </th>
            {grid.oppStrategies.map((opp) => {
              const race = (grid.oppStrategyRace.get(opp) || "U") as RaceLetter;
              return (
                <th key={opp} className="px-2 py-2 text-center">
                  <div className="flex flex-col items-center gap-0.5">
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-6 rounded"
                      style={{ background: raceAccent(race) }}
                    />
                    <span
                      className="block max-w-[140px] truncate text-text-muted"
                      title={opp}
                    >
                      {opp}
                    </span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.myBuilds.map((my) => (
            <tr key={my} className="border-t border-border/60">
              <th
                scope="row"
                className="sticky left-0 bg-bg-elevated/40 px-3 py-1 text-left text-text"
                title={my}
              >
                <span className="block max-w-[180px] truncate">{my}</span>
              </th>
              {grid.oppStrategies.map((opp) => {
                const cell = grid.cells.get(cellKey(my, opp));
                const isSelected =
                  selected?.myBuild === my && selected.oppStrategy === opp;
                return (
                  <td key={opp} className="px-1 py-1 text-center">
                    <MatrixCellButton
                      cell={cell}
                      myBuild={my}
                      oppStrategy={opp}
                      isSelected={isSelected}
                      onSelect={onSelect}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixCellButton({
  cell,
  myBuild,
  oppStrategy,
  isSelected,
  onSelect,
}: {
  cell: MatrixCell | undefined;
  myBuild: string;
  oppStrategy: string;
  isSelected: boolean;
  onSelect: (sel: BuildMatchupSelection | null) => void;
}) {
  if (!cell || cell.total === 0) {
    return (
      <span
        className="inline-flex min-h-[44px] min-w-[64px] items-center justify-center text-text-dim"
        aria-label={`No games when you played ${myBuild} and they played ${oppStrategy}`}
      >
        —
      </span>
    );
  }
  const tint = wrColor(cell.winRate, cell.total);
  const ramp = wrRamp(cell.winRate);
  const bg = `rgba(${ramp[0]}, ${ramp[1]}, ${ramp[2]}, ${cell.total < 3 ? 0.2 : 0.32})`;
  const wrPct = Math.round(cell.winRate * 100);
  return (
    <button
      type="button"
      onClick={() =>
        onSelect(isSelected ? null : { myBuild, oppStrategy })
      }
      title={`When you played ${myBuild} and they played ${oppStrategy} → ${cell.wins}-${cell.losses} (${wrPct}%) over ${cell.total} game${cell.total === 1 ? "" : "s"}.`}
      aria-label={`${myBuild} versus ${oppStrategy}: ${wrPct} percent over ${cell.total} games`}
      aria-pressed={isSelected}
      className={[
        "inline-flex min-h-[44px] min-w-[64px] flex-col items-center justify-center rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        isSelected ? "ring-2 ring-accent" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ background: bg, color: tint }}
    >
      <span className="text-[12px] font-semibold tabular-nums">{wrPct}%</span>
      <span className="text-[10px] tabular-nums opacity-80">
        {cell.wins}-{cell.losses}
      </span>
    </button>
  );
}

function Legend({
  oppStrategies,
  races,
}: {
  oppStrategies: string[];
  races: Map<string, string>;
}) {
  if (oppStrategies.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 text-[11px]">
      <span className="text-text-dim">Race accent (legend only):</span>
      {oppStrategies.map((opp) => {
        const race = (races.get(opp) || "U") as RaceLetter;
        return (
          <span
            key={opp}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-elevated/60 px-2 py-0.5 text-text-muted"
            title={`${opp} · ${raceFullName(race)}`}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: raceAccent(race) }}
            />
            {opp}
          </span>
        );
      })}
    </div>
  );
}

function SizeToggle({
  value,
  onChange,
}: {
  value: 5 | 10 | "all";
  onChange: (v: 5 | 10 | "all") => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Matrix size"
      className="inline-flex rounded-md border border-border bg-bg-elevated/60 p-0.5"
    >
      {SIZE_OPTIONS.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            "min-h-[44px] rounded px-3 py-1 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            value === opt.value
              ? "bg-accent/15 text-accent"
              : "text-text-muted hover:text-text",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

"use client";

import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { wrColor } from "@/lib/format";
import { buildRows, deriveDisplay } from "./buildRows";
import type {
  BuildTransitionFlowProps,
  FlowRow,
  FlowStep,
  MatchupFilter,
  TransitionEdge,
} from "./types";
import { COLUMN_TITLES } from "./types";

/**
 * BuildTransitionFlow — readable replacement for the Nivo Sankey. Each
 * row in the table represents a single end-to-end path through the
 * build → opponent strategy → final phase → late-game composition
 * funnel, with explicit win/loss counts and a clickable affordance.
 *
 * Why not a Sankey: the diagram was unreadable on mobile (rotated
 * labels, edge tangles, off-screen tooltips), gave no W/L information
 * without hovering, and couldn't be summarized at a glance. This
 * implementation is a vertical card list on mobile and a striped table
 * on desktop — same data, immediately scannable.
 */

const MIN_NODES_FOR_GRAPH = 4;
const RARE_NODES_LIMIT = 5;
const LOW_CONFIDENCE_GAMES = 5;

export function BuildTransitionFlow({
  transitions,
  matchupFilter: matchupFilterProp,
  onEdgeClick,
}: BuildTransitionFlowProps) {
  const tablistId = useId();
  const t = transitions.transitions;
  const rawNodes = t.nodes;
  const rawEdges = t.edges;
  const byMatchup = t.byMatchup;

  const matchupKeys = useMemo<string[]>(() => {
    const out: string[] = ["All"];
    if (byMatchup) {
      const extras = Object.keys(byMatchup).sort();
      for (const k of extras) out.push(k);
    }
    return out;
  }, [byMatchup]);

  const [internalFilter, setInternalFilter] = useState<MatchupFilter>("All");
  const isControlled = matchupFilterProp !== undefined;
  const activeFilter: MatchupFilter = isControlled
    ? (matchupFilterProp as MatchupFilter)
    : internalFilter;

  const setFilter = (next: MatchupFilter) => {
    if (!isControlled) setInternalFilter(next);
  };

  const { displayNodes, displayEdges } = useMemo(
    () => deriveDisplay(rawNodes, rawEdges, byMatchup, activeFilter),
    [rawNodes, rawEdges, byMatchup, activeFilter],
  );

  const rows = useMemo(
    () => buildRows(displayNodes, displayEdges),
    [displayNodes, displayEdges],
  );

  const tooSparse =
    rawNodes.length < MIN_NODES_FOR_GRAPH ||
    t.rare.collapsedNodes >= RARE_NODES_LIMIT;

  if (tooSparse) {
    return (
      <EmptyState
        title="Need a few more games to map your transitions"
        sub="Once you've played ~5 games on this build, the flow fills in."
      />
    );
  }

  const fireEdgeClick = (edge: TransitionEdge) => {
    if (!onEdgeClick) return;
    onEdgeClick({ nodes: [edge.from, edge.to], games: edge.games });
  };

  return (
    <div
      className="space-y-3"
      data-testid="build-transition-sankey"
      data-matchup={activeFilter}
    >
      {matchupKeys.length > 1 ? (
        <MatchupPillBar
          items={matchupKeys}
          active={activeFilter}
          onSelect={setFilter}
          tablistId={tablistId}
        />
      ) : null}
      {rows.length === 0 ? (
        <div
          className="rounded-lg border border-border bg-bg-surface p-6 text-center text-caption text-text-muted"
          data-testid="build-transition-sankey-no-edges"
        >
          No transitions in this matchup yet.
        </div>
      ) : (
        <FlowGrid
          buildName={transitions.name}
          rows={rows}
          onEdgeClick={onEdgeClick ? fireEdgeClick : undefined}
        />
      )}
      <SrOnlyEdgesTable
        buildName={transitions.name}
        edges={displayEdges}
        onEdgeClick={onEdgeClick ? fireEdgeClick : undefined}
      />
    </div>
  );
}

function MatchupPillBar({
  items,
  active,
  onSelect,
  tablistId,
}: {
  items: string[];
  active: MatchupFilter;
  onSelect: (next: MatchupFilter) => void;
  tablistId: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Matchup filter"
      id={tablistId}
      className="flex flex-wrap items-center gap-1"
      data-testid="matchup-pill-bar"
    >
      {items.map((item) => {
        const selected = item === active;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid="matchup-pill"
            data-matchup={item}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(item)}
            className={[
              "inline-flex min-h-[32px] items-center rounded-full border px-3 text-caption transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              selected
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

function FlowGrid({
  buildName,
  rows,
  onEdgeClick,
}: {
  buildName: string;
  rows: FlowRow[];
  onEdgeClick?: (e: TransitionEdge) => void;
}) {
  return (
    <figure
      className="rounded-lg border border-border bg-bg-surface"
      data-testid="build-transition-sankey-figure"
      aria-label={`How games on ${buildName} typically play out`}
    >
      <ul className="divide-y divide-border" data-testid="flow-row-list">
        {rows.map((row) => (
          <FlowRowItem key={row.key} row={row} onEdgeClick={onEdgeClick} />
        ))}
      </ul>
      <figcaption className="border-t border-border px-3 py-2 text-micro text-text-dim">
        Each row is one path through the funnel. Counts come from games
        that followed that exact sequence; dim rows have fewer than{" "}
        {LOW_CONFIDENCE_GAMES} samples.
      </figcaption>
    </figure>
  );
}

function FlowRowItem({
  row,
  onEdgeClick,
}: {
  row: FlowRow;
  onEdgeClick?: (e: TransitionEdge) => void;
}) {
  const denom = row.wins + row.losses;
  const wrLabel = denom > 0 ? `${Math.round(row.winRate * 100)}%` : "—";
  const wrTone = wrColor(row.winRate, row.games);
  const lowConfidence = row.games < LOW_CONFIDENCE_GAMES;
  const interactive =
    !!onEdgeClick && row.steps.length >= 2 && row.games > 0;

  const activate = () => {
    if (!onEdgeClick || row.steps.length < 2) return;
    onEdgeClick({
      from: row.steps[0].nodeId,
      to: row.steps[row.steps.length - 1].nodeId,
      games: row.games,
      wins: row.wins,
      losses: row.losses,
      winRate: row.winRate,
    });
  };

  // Mirror each step into a data attribute so the sr-only table can be
  // cross-referenced with the visible row from automated tests.
  const fromId = row.steps[0]?.nodeId ?? "";
  const toId = row.steps[row.steps.length - 1]?.nodeId ?? "";

  return (
    <li
      className={[
        "px-3 py-3",
        lowConfidence ? "opacity-70" : "",
      ].join(" ")}
      data-testid="flow-row"
      data-edge-from={fromId}
      data-edge-to={toId}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <FlowSteps steps={row.steps} />
        <div className="flex flex-shrink-0 items-center gap-2 sm:ml-auto">
          <span
            className="inline-flex h-7 items-center rounded-md border border-border bg-bg-elevated px-2 font-mono text-micro tabular-nums"
            style={{ color: wrTone }}
            title={
              denom > 0
                ? `${row.wins} wins, ${row.losses} losses`
                : "No completed games yet"
            }
          >
            {row.wins}–{row.losses}
            <span className="ml-1 text-text-dim">·</span>
            <span className="ml-1">{wrLabel}</span>
          </span>
          <span className="whitespace-nowrap text-micro text-text-dim">
            {row.games} game{row.games === 1 ? "" : "s"}
          </span>
          {interactive ? (
            <button
              type="button"
              onClick={activate}
              aria-label={`Open games for ${row.steps.map((s) => s.label).join(" → ")}`}
              title="Open games on this line"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function FlowSteps({ steps }: { steps: FlowStep[] }) {
  return (
    <ol
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5"
      aria-label="Path through the funnel"
    >
      {steps.map((step, idx) => (
        <li
          key={`${step.nodeId}-${idx}`}
          className="inline-flex items-center gap-1.5"
        >
          {idx > 0 ? (
            <ChevronRight
              className="h-3.5 w-3.5 flex-shrink-0 text-text-dim"
              aria-hidden
            />
          ) : null}
          <FlowStepChip step={step} />
        </li>
      ))}
    </ol>
  );
}

function FlowStepChip({ step }: { step: FlowStep }) {
  const tone = chipTone(step.kind);
  const showIcons =
    step.kind === "lateComp" &&
    step.iconTokens &&
    step.iconTokens.length > 0;
  const label = humanizeLabel(step);
  return (
    <span
      className={[
        "inline-flex max-w-[14rem] items-center gap-1 truncate rounded-md border px-2 py-1 text-caption",
        tone,
      ].join(" ")}
      title={`${COLUMN_TITLES[step.kind]}: ${label}`}
    >
      <span
        aria-hidden
        className="text-micro uppercase tracking-wider opacity-70"
      >
        {chipPrefix(step.kind)}
      </span>
      {showIcons ? (
        <span className="inline-flex items-center gap-0.5">
          {step.iconTokens!.slice(0, 3).map((tok) => (
            <Icon
              key={tok}
              name={tok}
              kind="unit"
              size={16}
              alt={tok}
            />
          ))}
        </span>
      ) : null}
      <span className="truncate font-medium">{label}</span>
    </span>
  );
}

function chipTone(kind: FlowStep["kind"]): string {
  switch (kind) {
    case "build":
      return "border-accent/40 bg-accent/10 text-accent";
    case "oppStrategy":
      return "border-border bg-bg-elevated text-text";
    case "oppRace":
      return "border-danger/40 bg-danger/10 text-danger";
    case "finalPhase":
      return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
    case "lateComp":
      return "border-warning/40 bg-warning/10 text-warning";
    default:
      return "border-border bg-bg-elevated text-text";
  }
}

function chipPrefix(kind: FlowStep["kind"]): string {
  switch (kind) {
    case "build":
      return "Build";
    case "oppStrategy":
      return "Strat";
    case "oppRace":
      return "Race";
    case "finalPhase":
      return "Ends";
    case "lateComp":
      return "Comp";
    default:
      return "";
  }
}

function humanizeLabel(step: FlowStep): string {
  if (step.kind === "finalPhase") return phaseLabel(step.label);
  if (step.kind === "lateComp" && step.iconTokens && step.iconTokens.length) {
    return step.iconTokens.slice(0, 3).join(" + ");
  }
  return step.label;
}

function phaseLabel(label: string): string {
  switch (label) {
    case "early":
      return "Early";
    case "earlyMid":
      return "Early/Mid";
    case "mid":
      return "Mid";
    case "midLate":
      return "Mid/Late";
    case "late":
      return "Late";
    default:
      return label;
  }
}

function SrOnlyEdgesTable({
  buildName,
  edges,
  onEdgeClick,
}: {
  buildName: string;
  edges: TransitionEdge[];
  onEdgeClick?: (e: TransitionEdge) => void;
}) {
  return (
    <table className="sr-only" data-testid="build-transition-sankey-table">
      <caption>
        Build transitions for {buildName}: from, to, games, wins–losses, win
        rate.
      </caption>
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col">Games</th>
          <th scope="col">W–L</th>
          <th scope="col">Win rate</th>
          {onEdgeClick ? <th scope="col">Open</th> : null}
        </tr>
      </thead>
      <tbody>
        {edges.map((e) => {
          const denom = e.wins + e.losses;
          const wrLabel =
            denom > 0 ? `${Math.round(e.winRate * 100)}%` : "—";
          return (
            <tr
              key={`${e.from}->${e.to}`}
              data-testid="transition-edge-row"
              data-edge-from={e.from}
              data-edge-to={e.to}
            >
              <td>{e.from}</td>
              <td>{e.to}</td>
              <td>{e.games}</td>
              <td>
                {e.wins}–{e.losses}
              </td>
              <td>{wrLabel}</td>
              {onEdgeClick ? (
                <td>
                  <button
                    type="button"
                    data-testid="transition-edge-button"
                    data-edge-from={e.from}
                    data-edge-to={e.to}
                    onClick={() => onEdgeClick(e)}
                  >
                    Open {e.from} → {e.to}
                  </button>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

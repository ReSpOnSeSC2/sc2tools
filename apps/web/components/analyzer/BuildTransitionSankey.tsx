"use client";

import { useId, useMemo, useState } from "react";
import { ResponsiveSankey } from "@nivo/sankey";
import { EmptyState } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";

/**
 * BuildTransitionSankey — Sankey routing of a build's games through
 * (col 0) build → (col 1) opponent strategy → (col 2) final phase →
 * (col 3) late-game composition. Variable depth: games ending before
 * the late window terminate at their col-2 node (3-step path).
 *
 * Filtering: when ``transitions.byMatchup`` is present, the matchup
 * pill bar re-derives the displayed edges/nodes client-side. When
 * absent, the bar shows only "All".
 *
 * a11y: rendered as a <figure role="img" aria-label="...">; the same
 * edges are mirrored into an off-screen <table> for screen readers.
 * That table also exposes each edge as a focusable button so keyboard
 * users (who can't activate an SVG link path) get the same
 * ``onEdgeClick`` affordance.
 */

export type TransitionNodeId = string;

export type TransitionNodeKind =
  | "build"
  | "oppStrategy"
  | "finalPhase"
  | "lateComp"
  // Opponent-profile column scheme uses this kind for col 1
  // (opponent's race). Build-mode payloads never emit it.
  | "oppRace";

export interface TransitionNode {
  id: TransitionNodeId;
  label: string;
  column: 0 | 1 | 2 | 3;
  kind: TransitionNodeKind;
  games: number;
  wins: number;
  losses: number;
  iconTokens?: string[];
}

export interface TransitionEdge {
  from: TransitionNodeId;
  to: TransitionNodeId;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface BuildTransitionsPayload {
  slug: string;
  name: string;
  transitions: {
    nodes: TransitionNode[];
    edges: TransitionEdge[];
    rare: { collapsedNodes: number; collapsedEdges: number };
    /**
     * Optional per-matchup edge counts. Keys are matchup tokens like
     * "PvP" / "PvT" / "TvZ". Each entry refers back to the canonical
     * ``edges`` array by index so the client only has to keep one
     * topology copy in memory.
     */
    byMatchup?: Record<
      string,
      Array<{
        edgeIdx: number;
        games: number;
        wins: number;
        losses: number;
      }>
    >;
  };
}

export type MatchupFilter = "All" | string;

export interface BuildTransitionSankeyProps {
  transitions: BuildTransitionsPayload;
  /** When provided, the pill bar becomes controlled. */
  matchupFilter?: MatchupFilter;
  onEdgeClick?: (path: {
    nodes: TransitionNodeId[];
    games: number;
  }) => void;
}

const MIN_NODES_FOR_GRAPH = 4;
const RARE_NODES_LIMIT = 5;
const LOW_CONFIDENCE_GAMES = 5;
const LOW_CONFIDENCE_ALPHA = 0.4;

const KIND_COLORS: Record<TransitionNodeKind, string> = {
  build: "#7c8cff", // --accent
  oppStrategy: "#9aa3b2", // --text-muted
  finalPhase: "#3ec0c7", // --accent-cyan
  lateComp: "#e6b450", // --warning
  // Distinct hue for the opponent-mode race column so it doesn't read
  // as the same kind as the col-2 strategy in the same Sankey.
  oppRace: "#c084fc", // --accent-purple-ish
};

const SANKEY_THEME = {
  background: "transparent",
  text: { fill: "#9aa3b2", fontSize: 11, fontWeight: 500 },
  tooltip: {
    container: {
      background: "#11141b",
      color: "#e6e8ee",
      border: "1px solid #1f2533",
      borderRadius: 8,
      padding: "8px 10px",
      fontSize: 12,
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.32)",
    },
  },
} as const;

export function BuildTransitionSankey({
  transitions,
  matchupFilter: matchupFilterProp,
  onEdgeClick,
}: BuildTransitionSankeyProps) {
  const captionId = useId();
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

  const sankeyData = useMemo(
    () => buildSankeyData(displayNodes, displayEdges),
    [displayNodes, displayEdges],
  );

  const tooSparse =
    rawNodes.length < MIN_NODES_FOR_GRAPH ||
    t.rare.collapsedNodes >= RARE_NODES_LIMIT;

  if (tooSparse) {
    return (
      <EmptyState
        title="Need a few more games to map your transitions"
        sub="Once you've played ~5 games on this build, the tree fills in."
      />
    );
  }

  const fireEdgeClick = (e: TransitionEdge) => {
    if (!onEdgeClick) return;
    onEdgeClick({ nodes: [e.from, e.to], games: e.games });
  };

  const ariaLabel =
    `Transitions for ${transitions.name}: ` +
    `${displayNodes.length} node${displayNodes.length === 1 ? "" : "s"}, ` +
    `${displayEdges.length} edge${displayEdges.length === 1 ? "" : "s"}.`;

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
        />
      ) : null}

      <figure
        role="img"
        aria-label={ariaLabel}
        aria-describedby={captionId}
        className="rounded-lg border border-border bg-bg-surface"
        data-testid="build-transition-sankey-figure"
      >
        <figcaption id={captionId} className="sr-only">
          {ariaLabel}
        </figcaption>
        <div style={{ height: 360 }} className="w-full">
          {sankeyData.links.length === 0 ? (
            <div
              className="flex h-full items-center justify-center px-4 text-caption text-text-muted"
              data-testid="build-transition-sankey-no-edges"
            >
              No transitions in this matchup yet.
            </div>
          ) : (
            <ResponsiveSankey
              data={sankeyData}
              margin={{ top: 12, right: 110, bottom: 12, left: 56 }}
              align="justify"
              sort="auto"
              colors={(d: { kind?: TransitionNodeKind }) =>
                d.kind ? KIND_COLORS[d.kind] : KIND_COLORS.build
              }
              nodeOpacity={0.95}
              nodeThickness={14}
              nodeSpacing={12}
              nodeBorderWidth={0}
              nodeBorderRadius={2}
              linkOpacity={1}
              linkContract={2}
              linkBlendMode="normal"
              enableLinkGradient={false}
              labelPosition="outside"
              labelOrientation="horizontal"
              labelPadding={6}
              label={(n: { nodeLabel?: string; id: string }) =>
                truncateLabel(n.nodeLabel ?? n.id, 22)
              }
              labelTextColor={{ from: "color", modifiers: [["brighter", 0.8]] }}
              theme={SANKEY_THEME}
              isInteractive
              onClick={(data) => {
                const link = data as unknown as {
                  source?: { id?: string };
                  target?: { id?: string };
                  games?: number;
                  value?: number;
                };
                if (!link || !link.source || !link.target) return;
                fireEdgeClick({
                  from: String(link.source.id ?? ""),
                  to: String(link.target.id ?? ""),
                  games: link.games ?? link.value ?? 0,
                  wins: 0,
                  losses: 0,
                  winRate: 0,
                });
              }}
              linkTooltip={({ link }: { link: SankeyLinkLike }) => (
                <EdgeTooltip
                  from={String(link.source?.id ?? "")}
                  to={String(link.target?.id ?? "")}
                  games={link.games ?? link.value ?? 0}
                  wins={link.wins ?? 0}
                  losses={link.losses ?? 0}
                  winRate={link.winRate ?? 0}
                />
              )}
              nodeTooltip={({ node }: { node: SankeyNodeLike }) => (
                <NodeTooltip
                  label={node.nodeLabel ?? node.id}
                  games={node.games ?? node.value ?? 0}
                  wins={node.wins ?? 0}
                  losses={node.losses ?? 0}
                />
              )}
            />
          )}
        </div>
      </figure>

      <SrOnlyEdgesTable
        buildName={transitions.name}
        edges={displayEdges}
        onEdgeClick={onEdgeClick ? fireEdgeClick : undefined}
      />
    </div>
  );
}

function deriveDisplay(
  rawNodes: TransitionNode[],
  rawEdges: TransitionEdge[],
  byMatchup: BuildTransitionsPayload["transitions"]["byMatchup"],
  filter: MatchupFilter,
): { displayNodes: TransitionNode[]; displayEdges: TransitionEdge[] } {
  if (filter === "All" || !byMatchup || !byMatchup[filter]) {
    return { displayNodes: rawNodes, displayEdges: rawEdges };
  }
  const entries = byMatchup[filter];
  const filteredEdges: TransitionEdge[] = [];
  for (const e of entries) {
    if (e.games <= 0) continue;
    const base = rawEdges[e.edgeIdx];
    if (!base) continue;
    const denom = e.wins + e.losses;
    filteredEdges.push({
      from: base.from,
      to: base.to,
      games: e.games,
      wins: e.wins,
      losses: e.losses,
      winRate: denom > 0 ? e.wins / denom : 0,
    });
  }
  const reachable = new Set<TransitionNodeId>();
  for (const e of filteredEdges) {
    reachable.add(e.from);
    reachable.add(e.to);
  }
  for (const n of rawNodes) if (n.column === 0) reachable.add(n.id);
  const filteredNodes = rawNodes.filter((n) => reachable.has(n.id));
  return { displayNodes: filteredNodes, displayEdges: filteredEdges };
}

type SankeyLinkLike = {
  source?: { id?: string };
  target?: { id?: string };
  value?: number;
  games?: number;
  wins?: number;
  losses?: number;
  winRate?: number;
};

type SankeyNodeLike = {
  id: string;
  nodeLabel?: string;
  value?: number;
  games?: number;
  wins?: number;
  losses?: number;
};

function buildSankeyData(
  nodes: TransitionNode[],
  edges: TransitionEdge[],
): {
  nodes: Array<{
    id: string;
    nodeLabel: string;
    kind: TransitionNodeKind;
    column: 0 | 1 | 2 | 3;
    games: number;
    wins: number;
    losses: number;
  }>;
  links: Array<{
    source: string;
    target: string;
    value: number;
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    startColor: string;
    endColor: string;
  }>;
} {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      nodeLabel: displayLabel(n),
      kind: n.kind,
      column: n.column,
      games: n.games,
      wins: n.wins,
      losses: n.losses,
    })),
    links: edges.map((e) => {
      const base = wrColor(e.winRate, e.games);
      const alpha = e.games < LOW_CONFIDENCE_GAMES ? LOW_CONFIDENCE_ALPHA : 1;
      const tinted = withAlpha(base, alpha);
      return {
        source: e.from,
        target: e.to,
        value: Math.max(1, e.games),
        games: e.games,
        wins: e.wins,
        losses: e.losses,
        winRate: e.winRate,
        startColor: tinted,
        endColor: tinted,
      };
    }),
  };
}

function displayLabel(n: TransitionNode): string {
  if (n.kind === "lateComp" && n.iconTokens && n.iconTokens.length > 0) {
    return n.iconTokens.slice(0, 2).join(" · ");
  }
  return n.label;
}

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return label.slice(0, Math.max(0, max - 1)) + "…";
}

function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return color;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function MatchupPillBar({
  items,
  active,
  onSelect,
}: {
  items: string[];
  active: MatchupFilter;
  onSelect: (next: MatchupFilter) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Matchup filter"
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
                ? "border-accent bg-accent text-white"
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

function EdgeTooltip({
  from,
  to,
  games,
  wins,
  losses,
  winRate,
}: {
  from: string;
  to: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}) {
  const denom = wins + losses;
  const wrLabel = denom > 0 ? `${Math.round(winRate * 100)}%` : "—";
  return (
    <div
      className="rounded-md border border-border bg-bg-surface px-2.5 py-2 text-caption"
      data-testid="edge-tooltip"
    >
      <div className="font-medium text-text">
        {from} → {to}
      </div>
      <div className="mt-1 flex items-center gap-3 text-text-muted">
        <span>
          <span className="tabular-nums text-text">
            {wins}–{losses}
          </span>
          <span className="ml-1 text-text-dim">W–L</span>
        </span>
        <span className="tabular-nums">{wrLabel}</span>
        <span className="text-text-dim">
          · {games} game{games === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function NodeTooltip({
  label,
  games,
  wins,
  losses,
}: {
  label: string;
  games: number;
  wins: number;
  losses: number;
}) {
  return (
    <div
      className="rounded-md border border-border bg-bg-surface px-2.5 py-2 text-caption"
      data-testid="node-tooltip"
    >
      <div className="font-medium text-text">{label}</div>
      <div className="mt-1 text-text-muted tabular-nums">
        {wins}–{losses} · {games} game{games === 1 ? "" : "s"}
      </div>
    </div>
  );
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
    <table
      className="sr-only"
      data-testid="build-transition-sankey-table"
    >
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

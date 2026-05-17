/**
 * Shared types for the build-flow visualization (replaces the previous
 * Nivo Sankey). Re-exports the canonical names from
 * BuildTransitionSankey so existing call-sites that import the types
 * from there keep compiling.
 */

export type TransitionNodeId = string;

export type TransitionNodeKind =
  | "build"
  | "oppStrategy"
  | "finalPhase"
  | "lateComp"
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

export interface BuildTransitionFlowProps {
  transitions: BuildTransitionsPayload;
  matchupFilter?: MatchupFilter;
  onEdgeClick?: (path: {
    nodes: TransitionNodeId[];
    games: number;
  }) => void;
}

/**
 * A "row" in the flow visualization — a build → strategy → final phase
 * → composition path with aggregated stats. Rare/sparse paths are
 * merged into an "Other" row by the caller before display.
 */
export interface FlowRow {
  key: string;
  steps: FlowStep[];
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface FlowStep {
  nodeId: TransitionNodeId;
  label: string;
  kind: TransitionNodeKind;
  iconTokens?: string[];
}

export const COLUMN_TITLES: Record<TransitionNodeKind, string> = {
  build: "Your build",
  oppStrategy: "Opponent strategy",
  oppRace: "Opponent race",
  finalPhase: "Game ends in",
  lateComp: "Late-game composition",
};
